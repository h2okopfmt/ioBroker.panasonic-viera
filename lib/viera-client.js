'use strict';

const http = require('http');
const { execFile } = require('child_process');
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
    static turnOnAppleTv(appleTvConfig, log) {
        const atvremotePath = VieraClient._findBinary('atvremote');
        const baseArgs = [];

        if (appleTvConfig.identifier) {
            baseArgs.push('--id', appleTvConfig.identifier);
        }
        if (appleTvConfig.address) {
            baseArgs.push('-s', appleTvConfig.address);
        }
        const creds = appleTvConfig.credentials || {};
        if (creds.mrp) baseArgs.push('--mrp-credentials', creds.mrp);
        if (creds.airplay) baseArgs.push('--airplay-credentials', creds.airplay);
        if (creds.companion) baseArgs.push('--companion-credentials', creds.companion);

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
        return name;
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
