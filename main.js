'use strict';

const utils = require('@iobroker/adapter-core');
const VieraClient = require('./lib/viera-client');

// Maps ioBroker state names to NRC key codes
const REMOTE_KEYS = {
    channelUp: 'NRC_CH_UP-ONOFF',
    channelDown: 'NRC_CH_DOWN-ONOFF',
    volumeUp: 'NRC_VOLUP-ONOFF',
    volumeDown: 'NRC_VOLDOWN-ONOFF',
    up: 'NRC_UP-ONOFF',
    down: 'NRC_DOWN-ONOFF',
    left: 'NRC_LEFT-ONOFF',
    right: 'NRC_RIGHT-ONOFF',
    ok: 'NRC_ENTER-ONOFF',
    enter: 'NRC_ENTER-ONOFF',
    back: 'NRC_RETURN-ONOFF',
    menu: 'NRC_MENU-ONOFF',
    home: 'NRC_MENU-ONOFF',
    play: 'NRC_PLAY-ONOFF',
    pause: 'NRC_PAUSE-ONOFF',
    stop: 'NRC_STOP-ONOFF',
    rewind: 'NRC_REW-ONOFF',
    forward: 'NRC_FF-ONOFF',
    red: 'NRC_RED-ONOFF',
    green: 'NRC_GREEN-ONOFF',
    yellow: 'NRC_YELLOW-ONOFF',
    blue: 'NRC_BLUE-ONOFF',
    epg: 'NRC_EPG-ONOFF',
    text: 'NRC_TEXT-ONOFF',
    subtitles: 'NRC_STTL-ONOFF',
    info: 'NRC_INFO-ONOFF',
    hdmi1: 'NRC_HDMI1-ONOFF',
    hdmi2: 'NRC_HDMI2-ONOFF',
    hdmi3: 'NRC_HDMI3-ONOFF',
    hdmi4: 'NRC_HDMI4-ONOFF',
    tv: 'NRC_TV-ONOFF',
    lastView: 'NRC_R_TUNE-ONOFF',
    d0: 'NRC_D0-ONOFF',
    d1: 'NRC_D1-ONOFF',
    d2: 'NRC_D2-ONOFF',
    d3: 'NRC_D3-ONOFF',
    d4: 'NRC_D4-ONOFF',
    d5: 'NRC_D5-ONOFF',
    d6: 'NRC_D6-ONOFF',
    d7: 'NRC_D7-ONOFF',
    d8: 'NRC_D8-ONOFF',
    d9: 'NRC_D9-ONOFF',
    '3d': 'NRC_3D-ONOFF',
    apps: 'NRC_APPS-ONOFF',
    mute: 'NRC_MUTE-ONOFF',
    submenu: 'NRC_SUBMENU-ONOFF',
    inputSwitch: 'NRC_CHG_INPUT-ONOFF',
    record: 'NRC_REC-ONOFF',
};

// Input name to NRC key mapping
const INPUT_KEYS = {
    HDMI1: 'NRC_HDMI1-ONOFF',
    HDMI2: 'NRC_HDMI2-ONOFF',
    HDMI3: 'NRC_HDMI3-ONOFF',
    HDMI4: 'NRC_HDMI4-ONOFF',
    TV: 'NRC_TV-ONOFF',
};

class PanasonicViera extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'panasonic-viera' });
        this.client = null;
        this.pollingTimer = null;
        this.tvAvailable = false;
        this._pairProcess = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        const ip = this.config.ip;
        if (!ip) {
            this.log.error('No TV IP address configured!');
            this.setState('info.connection', false, true);
            return;
        }

        this.client = new VieraClient(ip, this.log);
        this.log.info(`Panasonic Viera TV adapter starting for IP: ${ip}`);

        await this.createStates();
        this.subscribeStates('*');
        await this.pollStatus();
        this.startPolling();
    }

    async createStates() {
        // Power
        await this.setObjectNotExistsAsync('power', {
            type: 'state',
            common: { name: 'Power', type: 'boolean', role: 'switch.power', read: true, write: true, def: false },
            native: {},
        });

        // Volume
        await this.setObjectNotExistsAsync('volume', {
            type: 'state',
            common: { name: 'Volume', type: 'number', role: 'level.volume', read: true, write: true, min: 0, max: 100, def: 0 },
            native: {},
        });

        // Mute
        await this.setObjectNotExistsAsync('mute', {
            type: 'state',
            common: { name: 'Mute', type: 'boolean', role: 'media.mute', read: true, write: true, def: false },
            native: {},
        });

        // Channel (direct number input)
        await this.setObjectNotExistsAsync('channel', {
            type: 'state',
            common: { name: 'Channel Number', type: 'number', role: 'level.channel', read: false, write: true, min: 1, max: 9999 },
            native: {},
        });

        // Input source
        await this.setObjectNotExistsAsync('input', {
            type: 'state',
            common: {
                name: 'Input Source',
                type: 'string',
                role: 'media.input',
                read: false,
                write: true,
                states: { HDMI1: 'HDMI 1', HDMI2: 'HDMI 2', HDMI3: 'HDMI 3', HDMI4: 'HDMI 4', TV: 'TV' },
            },
            native: {},
        });

        // Remote control channel
        await this.setObjectNotExistsAsync('remote', {
            type: 'channel',
            common: { name: 'Remote Control' },
            native: {},
        });

        // Create all remote button states
        for (const [key, nrcCode] of Object.entries(REMOTE_KEYS)) {
            await this.setObjectAsync(`remote.${key}`, {
                type: 'state',
                common: { name: key, type: 'boolean', role: 'button', read: true, write: true, def: false },
                native: { nrcCode },
            });
            await this.setStateAsync(`remote.${key}`, false, true);
        }
    }

    startPolling() {
        const interval = (this.config.pollingInterval || 15) * 1000;
        this.pollingTimer = this.setInterval(() => this.pollStatus(), interval);
        this.log.debug(`Polling started with interval ${interval}ms`);
    }

    async pollStatus() {
        try {
            const available = await this.client.isAvailable();

            if (available !== this.tvAvailable) {
                this.tvAvailable = available;
                await this.setStateAsync('info.connection', available, true);
                await this.setStateAsync('power', available, true);
                this.log.debug(`TV ${available ? 'is now reachable' : 'is no longer reachable'}`);
            }

            if (available) {
                try {
                    const volume = await this.client.getVolume();
                    if (volume !== null) {
                        await this.setStateAsync('volume', volume, true);
                    }
                } catch (err) {
                    this.log.debug(`Could not get volume: ${err.message}`);
                }

                try {
                    const muted = await this.client.getMute();
                    if (muted !== null) {
                        await this.setStateAsync('mute', muted, true);
                    }
                } catch (err) {
                    this.log.debug(`Could not get mute state: ${err.message}`);
                }
            }
        } catch (err) {
            this.log.debug(`Polling error: ${err.message}`);
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;

        const stateName = id.split('.').pop();
        const channel = id.split('.').slice(-2, -1)[0];

        try {
            // Remote control buttons
            if (channel === 'remote') {
                const nrcCode = REMOTE_KEYS[stateName];
                if (nrcCode) {
                    this.log.debug(`Sending key: ${nrcCode}`);
                    await this.client.sendKey(nrcCode);
                    await this.setStateAsync(id, false, true);
                }
                return;
            }

            // Power
            if (stateName === 'power') {
                if (state.val) {
                    // Power ON - try Apple TV HDMI-CEC if enabled
                    if (this.config.useAppleTv) {
                        const appleTvConfig = this._getAppleTvConfig();
                        if (appleTvConfig) {
                            this.log.info('Powering on TV via Apple TV HDMI-CEC...');
                            try {
                                await VieraClient.turnOnAppleTv(appleTvConfig, this.log);
                                this.log.info('Apple TV wake sent');
                            } catch (err) {
                                this.log.error(`Apple TV turn_on failed: ${err.message}`);
                            }
                        }
                    } else {
                        this.log.warn('Power on not possible: Apple TV not configured. Enable in adapter settings.');
                    }
                } else {
                    // Power OFF via SOAP
                    this.log.info('Sending power off command');
                    await this.client.sendKey('NRC_POWER-ONOFF');
                }
                return;
            }

            // Volume
            if (stateName === 'volume') {
                const level = parseInt(state.val, 10);
                if (!isNaN(level)) {
                    this.log.debug(`Setting volume to ${level}`);
                    await this.client.setVolume(level);
                    await this.setStateAsync('volume', level, true);
                }
                return;
            }

            // Mute
            if (stateName === 'mute') {
                this.log.debug(`Setting mute to ${state.val}`);
                await this.client.setMute(!!state.val);
                await this.setStateAsync('mute', !!state.val, true);
                return;
            }

            // Channel number
            if (stateName === 'channel') {
                const ch = parseInt(state.val, 10);
                if (!isNaN(ch) && ch > 0) {
                    this.log.info(`Switching to channel ${ch}`);
                    await this.client.sendChannelNumber(ch);
                }
                return;
            }

            // Input source
            if (stateName === 'input') {
                const inputKey = INPUT_KEYS[String(state.val).toUpperCase()];
                if (inputKey) {
                    this.log.info(`Switching input to ${state.val}`);
                    await this.client.sendKey(inputKey);
                } else {
                    this.log.warn(`Unknown input: ${state.val}`);
                }
                return;
            }
        } catch (err) {
            this.log.error(`Error handling state change for ${id}: ${err.message}`);
        }
    }

    async onMessage(obj) {
        if (!obj || !obj.command) return;

        if (obj.command === 'testConnection') {
            try {
                const ip = obj.message && obj.message.ip || this.config.ip;
                if (!ip) {
                    await this._saveConnectionStatus('error', 'Keine IP-Adresse eingegeben');
                    this.sendTo(obj.from, obj.command, { result: '\uD83D\uDD34  Keine IP-Adresse eingegeben' }, obj.callback);
                    return;
                }
                const testClient = new VieraClient(ip, this.log);
                const available = await testClient.isAvailable();
                const msg = available ? `OK \u2014 TV erreichbar (${ip})` : 'Nicht erreichbar \u2014 TV eingeschaltet? TV Remote App aktiviert?';
                const emoji = available ? '\uD83D\uDFE2' : '\uD83D\uDD34';
                await this._saveConnectionStatus(available ? 'ok' : 'error', msg);
                this.sendTo(obj.from, obj.command, { result: `${emoji}  ${msg}` }, obj.callback);
            } catch (err) {
                await this._saveConnectionStatus('error', `Fehler: ${err.message}`);
                this.sendTo(obj.from, obj.command, { result: `\uD83D\uDD34  Fehler: ${err.message}` }, obj.callback);
            }
        }

        if (obj.command === 'scanAppleTv') {
            try {
                const devices = await VieraClient.scanAppleTvs(this.log);
                if (devices.length === 0) {
                    this.sendTo(obj.from, obj.command, { result: '\uD83D\uDD34  Kein Apple TV gefunden' }, obj.callback);
                } else {
                    const list = devices.map(d => `${d.name} (${d.address})`).join(', ');
                    // Save first device info to config
                    const dev = devices[0];
                    await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                        native: { appleTvIdentifier: dev.identifier, appleTvAddress: dev.address, appleTvName: dev.name },
                    });
                    this.sendTo(obj.from, obj.command, { result: `\uD83D\uDFE2  Gefunden: ${list}` }, obj.callback);
                }
            } catch (err) {
                this.sendTo(obj.from, obj.command, { result: `\uD83D\uDD34  Scan fehlgeschlagen: ${err.message}` }, obj.callback);
            }
        }

        if (obj.command === 'startPairing') {
            try {
                const protocol = (obj.message && obj.message.protocol) || 'airplay';
                const identifier = this.config.appleTvIdentifier;
                const address = this.config.appleTvAddress;
                if (!identifier && !address) {
                    this.sendTo(obj.from, obj.command, { result: '\uD83D\uDD34  Erst Apple TV scannen!' }, obj.callback);
                    return;
                }
                // Kill old process
                if (this._pairProcess) {
                    try { this._pairProcess.kill('SIGTERM'); } catch (_) {}
                    this._pairProcess = null;
                }
                const result = await VieraClient.pairStart(identifier, address, protocol, this.log);
                if (result.status === 'awaitingPin') {
                    this._pairProcess = result.process;
                    this.sendTo(obj.from, obj.command, { result: `\uD83D\uDFE2  PIN wird auf dem Apple TV angezeigt. Bitte eingeben und absenden.` }, obj.callback);
                } else if (result.status === 'paired') {
                    await this._storePairCredentials(protocol, result.credentials);
                    this.sendTo(obj.from, obj.command, { result: `\uD83D\uDFE2  Pairing erfolgreich (ohne PIN)!` }, obj.callback);
                }
            } catch (err) {
                this.sendTo(obj.from, obj.command, { result: `\uD83D\uDD34  Pairing fehlgeschlagen: ${err.message}` }, obj.callback);
            }
        }

        if (obj.command === 'submitPin') {
            try {
                const pin = obj.message && obj.message.pin;
                const protocol = (obj.message && obj.message.protocol) || 'airplay';
                if (!pin) {
                    this.sendTo(obj.from, obj.command, { result: '\uD83D\uDD34  Kein PIN eingegeben' }, obj.callback);
                    return;
                }
                if (!this._pairProcess) {
                    this.sendTo(obj.from, obj.command, { result: '\uD83D\uDD34  Kein aktiver Pairing-Prozess. Erst Pairing starten!' }, obj.callback);
                    return;
                }
                const result = await VieraClient.pairFinish(this._pairProcess, String(pin), this.log);
                this._pairProcess = null;
                if (result.credentials) {
                    await this._storePairCredentials(protocol, result.credentials);
                    this.sendTo(obj.from, obj.command, { result: `\uD83D\uDFE2  ${protocol}-Pairing erfolgreich! Credentials gespeichert.` }, obj.callback);
                } else {
                    this.sendTo(obj.from, obj.command, { result: `\uD83D\uDD34  Pairing abgeschlossen aber keine Credentials erhalten` }, obj.callback);
                }
            } catch (err) {
                this._pairProcess = null;
                this.sendTo(obj.from, obj.command, { result: `\uD83D\uDD34  PIN fehlgeschlagen: ${err.message}` }, obj.callback);
            }
        }
    }

    async _storePairCredentials(protocol, credentials) {
        const field = protocol === 'companion' ? 'appleTvCompanionCredentials'
            : protocol === 'airplay' ? 'appleTvAirplayCredentials'
                : 'appleTvMrpCredentials';
        await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
            native: { [field]: credentials },
        });
        this.log.info(`Stored ${protocol} credentials`);
    }

    _getAppleTvConfig() {
        const id = this.config.appleTvIdentifier;
        const addr = this.config.appleTvAddress;
        if (!id && !addr) return null;
        const airplay = this.config.appleTvAirplayCredentials || '';
        const companion = this.config.appleTvCompanionCredentials || '';
        if (!airplay && !companion) {
            this.log.warn('Apple TV not paired yet. Go to adapter settings and pair first.');
            return null;
        }
        return {
            identifier: id || '',
            address: addr || '',
            credentials: {
                mrp: this.config.appleTvMrpCredentials || '',
                airplay,
                companion,
            },
        };
    }

    async _saveConnectionStatus(status, message) {
        try {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                native: { connectionStatus: status, connectionMessage: message },
            });
        } catch (err) {
            this.log.debug(`Could not save connection status: ${err.message}`);
        }
    }

    onUnload(callback) {
        try {
            if (this.pollingTimer) {
                this.clearInterval(this.pollingTimer);
                this.pollingTimer = null;
            }
            if (this._pairProcess) {
                try { this._pairProcess.kill('SIGTERM'); } catch (_) {}
                this._pairProcess = null;
            }
            this.setState('info.connection', false, true);
        } catch (e) {
            // ignore
        }
        callback();
    }
}

if (require.main !== module) {
    module.exports = (options) => new PanasonicViera(options);
} else {
    new PanasonicViera();
}
