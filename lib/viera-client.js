'use strict';

const http = require('http');
const dgram = require('dgram');

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
     * Send Wake-on-LAN magic packet to turn on the TV
     */
    static sendWakeOnLan(mac) {
        return new Promise((resolve, reject) => {
            const macBytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
            if (macBytes.length !== 6) {
                return reject(new Error(`Invalid MAC address: ${mac}`));
            }

            // Magic packet: 6x 0xFF + 16x MAC address
            const magicPacket = Buffer.alloc(6 + 16 * 6);
            for (let i = 0; i < 6; i++) {
                magicPacket[i] = 0xff;
            }
            for (let i = 0; i < 16; i++) {
                macBytes.copy(magicPacket, 6 + i * 6);
            }

            const socket = dgram.createSocket('udp4');
            socket.once('error', (err) => {
                socket.close();
                reject(err);
            });

            socket.bind(() => {
                socket.setBroadcast(true);
                socket.send(magicPacket, 0, magicPacket.length, 9, '255.255.255.255', (err) => {
                    socket.close();
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        });
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
