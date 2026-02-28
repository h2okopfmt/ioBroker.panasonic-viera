'use strict';

const http = require('http');
const { execFile, spawn } = require('child_process');
const fs = require('fs');

const PORT = 55000;
const TIMEOUT = 5000;

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

        const creds = appleTvConfig.credentials || {};
        if (log) {
            log.info(`Apple TV config: address=${appleTvConfig.address || 'none'}, id=${appleTvConfig.identifier || 'none'}`);
            log.info(`Apple TV credentials: airplay=${creds.airplay ? 'yes (' + creds.airplay.length + ' chars)' : 'MISSING'}, companion=${creds.companion ? 'yes (' + creds.companion.length + ' chars)' : 'MISSING'}, mrp=${creds.mrp ? 'yes' : 'none'}`);
        }

        // Build args for a specific protocol (or no protocol restriction)
        const buildArgs = (protocol, port) => {
            const args = ['-m'];
            if (appleTvConfig.identifier) args.push('--id', appleTvConfig.identifier);
            if (appleTvConfig.address) args.push('--address', appleTvConfig.address);
            if (protocol) {
                args.push('--protocol', protocol);
                if (port) args.push('--port', String(port));
            }
            if (creds.mrp) args.push('--mrp-credentials', creds.mrp);
            if (creds.airplay) args.push('--airplay-credentials', creds.airplay);
            if (creds.companion) args.push('--companion-credentials', creds.companion);
            return args;
        };

        const tryCommand = (args, label) => {
            const safeArgs = args.map(a => a.length > 40 ? a.substring(0, 40) + '...' : a);
            if (log) log.info(`Apple TV [${label}]: ${atvremotePath} ${safeArgs.join(' ')}`);

            return new Promise((resolve, reject) => {
                execFile(atvremotePath, args, { timeout: 30000 }, (error, stdout, stderr) => {
                    const out = (stdout || '').trim();
                    const err = (stderr || '').trim();
                    if (out && log) log.info(`Apple TV [${label}] stdout: ${out.substring(0, 500)}`);
                    if (err && log) log.info(`Apple TV [${label}] stderr: ${err.substring(0, 500)}`);
                    if (error) {
                        reject(new Error(`${label}: ${error.message}`));
                        return;
                    }
                    if (log) log.info(`Apple TV [${label}]: OK`);
                    resolve({ result: 'success', label, raw: out });
                });
            });
        };

        // Multiple strategies - try each until one succeeds
        // Strategy 1: companion turn_on (most direct for newer tvOS)
        // Strategy 2: airplay turn_on (works on some setups)
        // Strategy 3: companion launch_app (opening an app triggers HDMI-CEC reliably)
        // Strategy 4: companion home_hold (wakes from sleep → CEC)
        const strategies = [
            { label: 'turn_on (companion)', args: [...buildArgs('companion', 49153), 'turn_on'] },
            { label: 'turn_on (airplay)', args: [...buildArgs('airplay', 7000), 'turn_on'] },
            { label: 'launch_app (companion)', args: [...buildArgs('companion', 49153), 'launch_app=com.apple.TVWatchList'] },
            { label: 'home_hold (companion)', args: [...buildArgs('companion', 49153), 'home_hold'] },
        ];

        for (const strategy of strategies) {
            try {
                const result = await tryCommand(strategy.args, strategy.label);
                return result;
            } catch (err) {
                if (log) log.warn(`Apple TV ${strategy.label} failed: ${err.message}`);
            }
        }

        throw new Error('All Apple TV wake strategies failed. Check credentials and network connectivity.');
    }

    /**
     * Scan for Apple TVs on the network.
     * If targetIp is given, uses unicast scan (--scan-hosts) which works in Docker.
     */
    static async scanAppleTvs(log, targetIp) {
        const atvremotePath = await VieraClient.ensureAtvremote(log);
        const args = targetIp ? ['--scan-hosts', targetIp, 'scan'] : ['scan'];
        if (log) log.info(`Apple TV scan: ${atvremotePath} ${args.join(' ')}`);

        return new Promise((resolve, reject) => {
            execFile(atvremotePath, args, { timeout: 15000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Scan failed: ${error.message}${stderr ? '. ' + stderr : ''}`));
                    return;
                }
                if (log) log.debug(`Scan output:\n${stdout}`);
                const devices = [];
                // Split into device blocks (separated by blank lines or ===)
                const blocks = stdout.split(/={3,}|\n\s*\n/);
                for (const block of blocks) {
                    const name = (block.match(/^\s*Name:\s*(.+)/mi) || [])[1];
                    const addr = (block.match(/^\s*Address:\s*(.+)/mi) || [])[1];
                    const mac = (block.match(/^\s*MAC:\s*(.+)/mi) || [])[1];
                    // Parse identifiers list (lines starting with " - " after "Identifiers:")
                    const idSection = block.match(/Identifiers:\s*\n((?:\s*-\s*.+\n?)+)/i);
                    let identifier = '';
                    if (idSection) {
                        const ids = idSection[1].match(/-\s*(.+)/g);
                        if (ids) {
                            // Prefer MAC-format identifier (AA:BB:CC:DD:EE:FF)
                            const macId = ids.map(s => s.replace(/^-\s*/, '').trim())
                                .find(s => /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(s));
                            identifier = macId || ids[0].replace(/^-\s*/, '').trim();
                        }
                    }
                    // Fallback: use MAC field as identifier
                    if (!identifier && mac) identifier = mac.trim();

                    if (name && (identifier || addr)) {
                        devices.push({
                            name: name.trim(),
                            identifier: identifier || '',
                            address: (addr || '').trim(),
                        });
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
        const defaultPorts = { airplay: 7000, companion: 49153 };
        const args = ['-m'];
        if (identifier) args.push('--id', identifier);
        if (address) args.push('--address', address);
        args.push('--protocol', proto);
        if (defaultPorts[proto]) args.push('--port', String(defaultPorts[proto]));
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
                } else if (code === 0) {
                    resolve({ status: 'paired', credentials: output.trim() });
                } else {
                    reject(new Error('Pairing failed after PIN (exit ' + code + '): ' + output.substring(0, 300)));
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
        for (let i = lines.length - 1; i >= 0; i--) {
            if (/^[0-9a-fA-F:]+$/.test(lines[i]) && lines[i].length > 20) return lines[i];
        }
        return null;
    }

    static _findBinary(name) {
        const searchPaths = [
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

    /**
     * Install pyatv via pip3/pip/python3 -m pip with fallbacks
     */
    static async installPyatv(log) {
        const { execSync } = require('child_process');

        // Try multiple install methods in order
        const methods = [
            { label: 'pip3', cmd: 'pip3 install pyatv' },
            { label: 'pip', cmd: 'pip install pyatv' },
            { label: 'python3 -m pip', cmd: 'python3 -m pip install pyatv' },
            { label: 'apt + pip3', cmd: 'apt-get update -qq && apt-get install -y -qq python3-pip > /dev/null 2>&1 && pip3 install pyatv' },
        ];

        for (const method of methods) {
            try {
                if (log) log.info(`Installing pyatv via ${method.label}...`);
                execSync(method.cmd, { timeout: 180000, stdio: 'pipe' });
                if (log) log.info(`pyatv installed successfully via ${method.label}`);
                return;
            } catch (err) {
                if (log) log.debug(`${method.label} failed: ${err.message}`);
            }
        }
        throw new Error('pyatv installation failed. Please install manually: pip3 install pyatv');
    }

    /**
     * Find atvremote binary, install pyatv if not found
     */
    static async ensureAtvremote(log) {
        let path = VieraClient._findBinary('atvremote');
        if (path) return path;

        // Not found - try to install
        if (log) log.warn('atvremote not found, installing pyatv...');
        await VieraClient.installPyatv(log);

        path = VieraClient._findBinary('atvremote');
        if (!path) {
            throw new Error('atvremote not found after installing pyatv. Check pip3 installation.');
        }
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
