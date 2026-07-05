'use strict';

const http = require('http');
const { execFile, spawn } = require('child_process');
const fs = require('fs');

const PORT = 55000;
const TIMEOUT = 5000;

// Persistent venv for pyatv — /opt/iobroker is the only volume that survives
// container recreation (buanet Docker image), so the venv must live there.
const PYATV_VENV = '/opt/iobroker/.pyatv-venv';

const URN_REMOTE = 'urn:panasonic-com:service:p00NetworkControl:1';
const URN_RENDER = 'urn:schemas-upnp-org:service:RenderingControl:1';

class VieraClient {
    constructor(ip, log) {
        this.ip = ip;
        this.log = log;
    }

    /**
     * Send a SOAP request to the TV
     */
    _soapRequest(path, urn, action, body) {
        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
 <s:Body>
  <u:${action} xmlns:u="${urn}">
   ${body}
  </u:${action}>
 </s:Body>
</s:Envelope>`;

        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.ip,
                port: PORT,
                path: path,
                method: 'POST',
                timeout: TIMEOUT,
                headers: {
                    'Content-Type': 'text/xml; charset="utf-8"',
                    'Content-Length': Buffer.byteLength(soapBody),
                    'SOAPAction': `"${urn}#${action}"`,
                },
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(data);
                    } else {
                        reject(new Error(`SOAP request failed: HTTP ${res.statusCode}`));
                    }
                });
            });

            req.on('error', (err) => reject(err));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('SOAP request timed out'));
            });

            req.write(soapBody);
            req.end();
        });
    }

    /**
     * Send a remote control key command
     */
    async sendKey(key) {
        const keyEvent = key.startsWith('NRC_') ? key : `NRC_${key}-ONOFF`;
        await this._soapRequest(
            '/nrc/control_0',
            URN_REMOTE,
            'X_SendKey',
            `<X_KeyEvent>${keyEvent}</X_KeyEvent>`
        );
    }

    /**
     * Get current volume level (0-100)
     */
    async getVolume() {
        const response = await this._soapRequest(
            '/dmr/control_0',
            URN_RENDER,
            'GetVolume',
            '<InstanceID>0</InstanceID><Channel>Master</Channel>'
        );
        const match = response.match(/<CurrentVolume>(\d+)<\/CurrentVolume>/);
        return match ? parseInt(match[1], 10) : null;
    }

    /**
     * Set volume level (0-100)
     */
    async setVolume(level) {
        level = Math.max(0, Math.min(100, Math.round(level)));
        await this._soapRequest(
            '/dmr/control_0',
            URN_RENDER,
            'SetVolume',
            `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${level}</DesiredVolume>`
        );
    }

    /**
     * Get mute status
     */
    async getMute() {
        const response = await this._soapRequest(
            '/dmr/control_0',
            URN_RENDER,
            'GetMute',
            '<InstanceID>0</InstanceID><Channel>Master</Channel>'
        );
        const match = response.match(/<CurrentMute>(\d+)<\/CurrentMute>/);
        return match ? match[1] === '1' : null;
    }

    /**
     * Set mute state
     */
    async setMute(enable) {
        await this._soapRequest(
            '/dmr/control_0',
            URN_RENDER,
            'SetMute',
            `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>${enable ? 1 : 0}</DesiredMute>`
        );
    }

    /**
     * Check if TV is reachable (power on and network available)
     */
    isAvailable() {
        return new Promise((resolve) => {
            const options = {
                hostname: this.ip,
                port: PORT,
                path: '/nrc/ddd.xml',
                method: 'GET',
                timeout: TIMEOUT,
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => resolve(res.statusCode === 200));
            });

            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.end();
        });
    }

    /**
     * Turn on Apple TV via atvscript (triggers HDMI-CEC to power on the TV)
     */
    static async turnOnAppleTv(appleTvConfig, log) {
        const atvremotePath = await VieraClient.ensureAtvremote(log);
        // Service ports are dynamic (companion may be 49152, 49153, ...), so do not
        // connect manually with a hardcoded port. A unicast scan (-s) of the known
        // address resolves the current ports in ~1-2s.
        const baseArgs = [];
        if (appleTvConfig.address) {
            baseArgs.push('-s', appleTvConfig.address);
        }
        if (appleTvConfig.identifier) {
            baseArgs.push('--id', appleTvConfig.identifier);
        }
        // Pick the protocol we actually have credentials for. Companion has native
        // turn_on support; airplay alone cannot power on.
        const creds = appleTvConfig.credentials || {};
        const protocol = creds.companion ? 'companion' : (creds.airplay ? 'airplay' : null);
        if (!protocol) {
            throw new Error('No Apple TV credentials available - pair the Apple TV in the adapter settings first');
        }
        baseArgs.push('--protocol', protocol);
        if (protocol === 'companion') {
            baseArgs.push('--companion-credentials', creds.companion);
        } else {
            baseArgs.push('--airplay-credentials', creds.airplay);
        }
        if (log) log.info(`Powering on Apple TV via ${protocol} protocol...`);

        // Try turn_on first, fall back to home_hold (wakes Apple TV from sleep → HDMI-CEC turns on TV)
        const tryCommand = (command) => {
            const args = [...baseArgs, command];
            if (log) log.debug(`Executing: ${atvremotePath} ${args.map(a => a.length > 20 ? a.substring(0, 20) + '...' : a).join(' ')}`);

            return new Promise((resolve, reject) => {
                execFile(atvremotePath, args, { timeout: 15000 }, (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(`atvremote ${command} failed: ${error.message}${stderr ? '. ' + stderr : ''}`));
                        return;
                    }
                    resolve({ result: 'success', command, raw: (stdout || '').trim() });
                });
            });
        };

        return tryCommand('turn_on').catch((err) => {
            if (log) log.warn(`turn_on failed (${err.message}), trying home_hold as fallback...`);
            return tryCommand('home_hold');
        });
    }

    /**
     * Scan for Apple TVs on the network
     */
    static async scanAppleTvs(log) {
        const atvremotePath = await VieraClient.ensureAtvremote(log);
        return new Promise((resolve, reject) => {
            execFile(atvremotePath, ['scan'], { timeout: 15000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Scan failed: ${error.message}${stderr ? '. ' + stderr : ''}`));
                    return;
                }
                const devices = [];
                const blocks = stdout.split(/\n\s*\n/);
                for (const block of blocks) {
                    const name = (block.match(/Name:\s*(.+)/i) || [])[1];
                    const id = (block.match(/Identifier:\s*(.+)/i) || [])[1];
                    const addr = (block.match(/Address:\s*(.+)/i) || [])[1];
                    if (name && id) {
                        devices.push({ name: name.trim(), identifier: id.trim(), address: (addr || '').trim() });
                    }
                }
                resolve(devices);
            });
        });
    }

    /**
     * Start Apple TV pairing process
     */
    static async pairStart(identifier, address, protocol, log) {
        const atvremotePath = await VieraClient.ensureAtvremote(log);
        const proto = protocol || 'airplay';
        // Resolve dynamic service ports via unicast scan instead of hardcoding
        const args = [];
        if (address) args.push('-s', address);
        if (identifier) args.push('--id', identifier);
        args.push('--protocol', proto);
        args.push('pair');

        if (log) log.info(`Starting pairing: ${atvremotePath} ${args.join(' ')}`);

        return new Promise((resolve, reject) => {
            let output = '';
            let resolved = false;

            const proc = spawn(atvremotePath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    try { proc.kill('SIGTERM'); } catch (_) {}
                    reject(new Error('Pairing timeout: Apple TV did not respond within 30 seconds'));
                }
            }, 30000);

            proc.stdout.on('data', (chunk) => {
                output += chunk.toString();
                if (!resolved && (output.includes('Enter PIN') || output.includes('pin:'))) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve({ status: 'awaitingPin', process: proc });
                }
            });

            proc.stderr.on('data', (chunk) => {
                output += chunk.toString();
                if (!resolved && (output.includes('Enter PIN') || output.includes('pin:'))) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve({ status: 'awaitingPin', process: proc });
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timeout);
                if (!resolved) { resolved = true; reject(new Error('Failed to start pairing: ' + err.message)); }
            });

            proc.on('exit', (code) => {
                clearTimeout(timeout);
                if (!resolved) {
                    resolved = true;
                    const credentials = VieraClient._extractCredentials(output);
                    if (credentials) {
                        resolve({ status: 'paired', credentials });
                    } else {
                        reject(new Error('Pairing failed (exit ' + code + '): ' + output.substring(0, 300)));
                    }
                }
            });
        });
    }

    /**
     * Submit PIN to running pairing process
     */
    static pairFinish(pairProcess, pin, log) {
        if (!pairProcess || pairProcess.killed) {
            throw new Error('No active pairing process');
        }

        return new Promise((resolve, reject) => {
            let output = '';
            let resolved = false;

            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    try { pairProcess.kill('SIGTERM'); } catch (_) {}
                    reject(new Error('PIN verification timeout'));
                }
            }, 30000);

            const onData = (chunk) => {
                const text = chunk.toString();
                output += text;
                if (log) log.debug(`pairFinish output: ${text.trim()}`);
            };
            pairProcess.stdout.on('data', onData);
            pairProcess.stderr.on('data', onData);

            pairProcess.on('exit', (code) => {
                clearTimeout(timeout);
                if (resolved) return;
                resolved = true;
                if (log) log.info(`Pairing process exited (code ${code}), full output: ${output.substring(0, 500)}`);
                const credentials = VieraClient._extractCredentials(output);
                if (log) log.info(`Extracted credentials: ${credentials ? credentials.substring(0, 30) + '...' : 'NONE'}`);
                if (credentials) {
                    resolve({ status: 'paired', credentials });
                } else {
                    reject(new Error('Pairing finished (exit ' + code + ') but no credentials could be parsed from output: ' + output.substring(0, 300)));
                }
            });

            try {
                pairProcess.stdin.write(pin + '\n');
            } catch (err) {
                clearTimeout(timeout);
                if (!resolved) { resolved = true; reject(new Error('Failed to send PIN: ' + err.message)); }
            }
        });
    }

    static _extractCredentials(output) {
        const lines = output.split('\n').map(l => l.trim()).filter(l => l);
        for (const line of lines) {
            const match = line.match(/[Cc]redentials?:\s*(.+)/);
            if (match) return match[1].trim();
        }
        // Real pyatv credentials are long colon-separated hex strings; require a ':'
        // and >40 chars so identifiers/MACs echoed in the output are not mistaken.
        for (let i = lines.length - 1; i >= 0; i--) {
            if (/^[0-9a-fA-F:]+$/.test(lines[i]) && lines[i].includes(':') && lines[i].length > 40) return lines[i];
        }
        return null;
    }

    static _findBinary(name) {
        const searchPaths = [
            PYATV_VENV + '/bin',
            '/usr/local/bin',
            '/usr/bin',
            '/home/iobroker/.local/bin',
            '/root/.local/bin',
            '/opt/iobroker/.local/bin',
            '/snap/bin',
        ];
        for (const dir of searchPaths) {
            const fullPath = dir + '/' + name;
            try {
                fs.accessSync(fullPath, fs.constants.X_OK);
                return fullPath;
            } catch (_) { /* not found */ }
        }
        // Scan /home/*/.local/bin/
        try {
            for (const user of fs.readdirSync('/home')) {
                const fullPath = `/home/${user}/.local/bin/${name}`;
                try {
                    fs.accessSync(fullPath, fs.constants.X_OK);
                    return fullPath;
                } catch (_) { /* not found */ }
            }
        } catch (_) { /* /home not readable */ }
        return null;
    }

    static _execFilePromise(file, args, timeout) {
        return new Promise((resolve, reject) => {
            execFile(file, args, { timeout }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`${file} ${args.join(' ')} failed: ${error.message}${stderr ? '. ' + stderr : ''}`));
                    return;
                }
                resolve(stdout);
            });
        });
    }

    /**
     * Create the persistent pyatv venv and install pyatv into it.
     * Serialized via a static promise so concurrent callers share one bootstrap.
     */
    static bootstrapPyatvVenv(log) {
        if (VieraClient._bootstrapPromise) return VieraClient._bootstrapPromise;

        VieraClient._bootstrapPromise = (async () => {
            const venvPython = PYATV_VENV + '/bin/python';
            if (!fs.existsSync(venvPython)) {
                if (log) log.info(`Creating pyatv venv at ${PYATV_VENV} (one-time, may take 1-3 minutes)...`);
                try {
                    await VieraClient._execFilePromise('python3', ['-m', 'venv', PYATV_VENV], 60000);
                } catch (err) {
                    throw new Error(
                        `Cannot create Python venv at ${PYATV_VENV} (python3-venv missing?). ` +
                        `One-time fix on the Docker host: docker exec -u root iobroker apt-get update && ` +
                        `docker exec -u root iobroker apt-get install -y python3-venv. ` +
                        `Also consider adding PACKAGES=python3-venv to the container env. (${err.message})`
                    );
                }
            }
            if (log) log.info('Installing pyatv into venv...');
            try {
                await VieraClient._execFilePromise(venvPython, ['-m', 'pip', 'install', 'pyatv'], 300000);
            } catch (err) {
                throw new Error(
                    `pip install pyatv failed. Delete ${PYATV_VENV} to retry from scratch. (${err.message})`
                );
            }
            if (log) log.info('pyatv installed successfully');
        })();

        // Allow a retry after failure instead of caching the rejection forever
        VieraClient._bootstrapPromise.catch(() => { VieraClient._bootstrapPromise = null; });
        return VieraClient._bootstrapPromise;
    }

    /**
     * Find atvremote binary (memoized), bootstrap the pyatv venv if not found
     */
    static async ensureAtvremote(log) {
        if (VieraClient._atvremotePath) {
            try {
                fs.accessSync(VieraClient._atvremotePath, fs.constants.X_OK);
                return VieraClient._atvremotePath;
            } catch (_) {
                VieraClient._atvremotePath = null;
            }
        }

        let path = VieraClient._findBinary('atvremote');
        if (!path) {
            if (log) log.warn('atvremote not found, bootstrapping pyatv venv...');
            await VieraClient.bootstrapPyatvVenv(log);
            path = VieraClient._findBinary('atvremote');
        }
        if (!path) {
            throw new Error(`atvremote not found after installing pyatv into ${PYATV_VENV}.`);
        }
        VieraClient._atvremotePath = path;
        return path;
    }

    /**
     * Send a channel number by pressing digit keys with delays
     */
    async sendChannelNumber(channelNumber) {
        const digits = String(channelNumber).split('');
        for (const digit of digits) {
            await this.sendKey(`NRC_D${digit}-ONOFF`);
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
    }
}

module.exports = VieraClient;
