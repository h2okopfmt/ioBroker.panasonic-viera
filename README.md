# ioBroker.panasonic-viera

Adapter zur Steuerung von Panasonic Viera TVs (SOAP/UPnP) mit optionaler Apple TV HDMI-CEC Einschaltfunktion.

## Funktionen

- **TV-Fernbedienung**: Alle gaengigen Tasten (Lautstaerke, Kanalwechsel, Navigation, Farbtasten, etc.)
- **Lautstaerke**: Lautstaerke lesen/setzen (0-100), Mute ein/aus
- **Kanalwahl**: Direkteingabe von Kanalnummern
- **TV einschalten via Apple TV**: Fuer TVs ohne Wake-on-LAN (z.B. TX-L47WTW60) - weckt den Apple TV per pyatv, HDMI-CEC schaltet den TV ein, danach automatischer Wechsel auf TV-Tuner

## Voraussetzungen

- Panasonic Viera TV mit Netzwerkanschluss (SOAP/UPnP auf Port 55000)
- TV Remote App muss im TV aktiviert sein (Menu > Netzwerk > TV Remote App > Ein)
- Optional: Apple TV im gleichen HDMI-CEC-Verbund fuer die Einschaltfunktion

## Installation

Im ioBroker Admin unter **Adapter** > **Von eigener URL installieren**:

```
https://github.com/h2okopfmt/ioBroker.panasonic-viera
```

## Konfiguration

| Einstellung | Beschreibung |
|---|---|
| **TV IP-Adresse** | IP des Panasonic Viera TV |
| **Polling-Intervall** | Abfrage-Intervall in Sekunden (Standard: 15) |
| **Apple TV einschalten** | Apple TV HDMI-CEC zum Einschalten nutzen |
| **Apple TV IP** | IP-Adresse des Apple TV |
| **Apple TV Identifier** | Wird automatisch ermittelt wenn die IP eingetragen ist (Scan-Button) |
| **AirPlay/Companion Credentials** | Werden ueber Pairing im Adapter-UI oder manuell eingetragen |

### Apple TV Pairing

1. Apple TV IP-Adresse eintragen und speichern
2. Scan-Button druecken um den Identifier automatisch zu ermitteln
3. AirPlay-Pairing starten > PIN vom Apple TV eingeben
4. Companion-Pairing starten > PIN vom Apple TV eingeben

**Hinweis fuer Docker**: Companion-Pairing funktioniert moeglicherweise nicht aus dem Container heraus. In dem Fall von einem Host mit pyatv pairen und die Credentials manuell in die Felder eintragen:

```bash
# Auf dem Host (nicht im Docker):
atvremote -m --id <IDENTIFIER> --address <IP> --protocol companion --port 49153 pair
atvremote -m --id <IDENTIFIER> --address <IP> --protocol airplay --port 7000 pair
```

## Docker-Hinweise

- **pyatv** wird automatisch in ein persistentes venv unter `/opt/iobroker/.pyatv-venv/` installiert und ueberlebt Container-Neustarts
- Der ioBroker-Container benoetigt **Netzwerkzugriff** auf den TV (Port 55000) und den Apple TV (Ports 7000, 49153). Bei macvlan/VLAN-Setups sicherstellen, dass der Container eine IP im gleichen Subnetz wie der TV hat
- mDNS funktioniert in Docker nicht - der Adapter nutzt automatisch Unicast-Scan (`--scan-hosts`)

## States

| State | Typ | Beschreibung |
|---|---|---|
| `power` | switch | TV ein-/ausschalten |
| `volume` | level (0-100) | Lautstaerke |
| `mute` | switch | Stummschaltung |
| `channel` | level | Kanalnummer direkt eingeben |
| `input` | text | TV-Eingang (z.B. NRC_TV-ONOFF) |
| `remote.*` | button | Fernbedienungstasten |

## Einschaltablauf (Apple TV)

1. `power` auf `true` setzen
2. Adapter weckt Apple TV via Companion-Protokoll (`turn_on`)
3. Apple TV wacht auf > HDMI-CEC schaltet TV ein
4. Adapter wartet bis TV erreichbar ist (max. 5 Versuche)
5. Automatischer Wechsel auf TV-Tuner (`NRC_TV-ONOFF`)

## Getestet mit

- Panasonic TX-L47WTW60 (NRC-3.00, kein WOL)
- Apple TV 4K
- ioBroker in Docker (buanet/iobroker)

## Lizenz

MIT
