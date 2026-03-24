# KastenKenner

> Browser-basiertes System zur Erkennung und Zählung von Flaschen in
> einem Bierkasten mittels einer **TAL220B Load Cell** an einem **Arduino Nano 33 BLE Sense**,
> verglichen über einen **Edge Impulse WASM-Modell** und einen
> **hardcoded gewichtsbasierten Classifier**.

---

## Was dieses Projekt macht

Ein Arduino Nano 33 BLE Sense mit einer TAL220B Load Cell (über einen NAU7802 ADC) misst
kontinuierlich das Gewicht auf dem Bierkasten und sendet die Daten per
USB Serial an den Browser. Dort laufen zwei Classifier parallel:

| Classifier | Beschreibung |
|---|---|
| **Hardcoded** | Zustandsautomat in `public/hardcode.js` — erkennt Gewichtsänderungen, wartet auf Beruhigung (~2 s), vergleicht mit kalibrierten Flaschengewichten, unterstützt Multi-Flaschen-Erkennung und Selbstkorrektur via absolutem Gewicht. |
| **Edge Impulse ML** | Exportiertes WASM-Modell, läuft lokal im Browser — keine Cloud-Aufrufe. |

Die UI zeigt beide Ergebnisse nebeneinander mit Live-Chart, Flaschenzähler
und Event-Log.

---

## Hardware

- **Arduino Nano 33 BLE Sense**
- **TAL220B Load Cell** (bis 5 kg)
- **NAU7802** Qwiic Scale (SparkFun)
- Verbindung: Load Cell → NAU7802 → I²C → Nano 33 BLE Sense → USB → PC

Der Arduino-Sketch liegt im Projektroot: `sketch_kastenkenner_model.ino.ino`

---

## Serielles Datenformat

Der Nano 33 BLE Sense sendet **eine Zeile pro Sample** bei **115200 Baud**, **5 Hz**:

```
raw,delta
```

Beispiel:

```
-1246970,-268
-1246742,228
-1078290,168452
```

- **raw** — Rohwert der Load Cell minus Tare-Offset (Integer)
- **delta** — Differenz zum vorherigen Rohwert (Integer)

---

## Kalibrierung

Die Kalibrierung erfolgt über die Browser-UI:

1. **Leerer Kasten (Tare)** — Kasten ohne Flaschen auf die Waage stellen
2. **Volle Flasche rein (890 g)** — eine volle Bierflasche reinstellen (5 s Countdown)
3. **Leere Flasche rein** — eine leere Flasche reinstellen (5 s Countdown)

Daraus berechnet das System automatisch:
- Gramm-pro-Roheinheit-Umrechnung (basierend auf dem bekannten Gewicht 890 g)
- Erwartetes Gewicht für volle und leere Flaschen
- Max. Kastenkapazität (einstellbar, Standard: 4)

Die Kalibrierung wird in `localStorage` gespeichert.

### Hardcoded Classifier Features

- **Zustandsautomat**: `stable` → `changing` → `settling` → Bestätigung
- **Multi-Flaschen-Erkennung**: Erkennt gleichzeitiges Rein-/Rausnehmen mehrerer Flaschen
- **Selbstkorrektur**: Zählerstand wird gegen absolutes Gewicht validiert und ggf. korrigiert
- **Kastenkapazitäts-Constraint**: Zähler kann Maximum nicht überschreiten

---

## Model-Parameter

| Parameter         | Wert |
|-------------------|------|
| Frequenz          | 5 Hz |
| Fenstergröße      | 1800 ms |
| Frames pro Fenster | **9** (5 × 1.8) |
| Werte pro Frame   | 2 (raw, delta) |
| **Model-Input**   | **18 numerische Werte** |

---

## Voraussetzungen

- **Node.js** ≥ 16
- **Chromium-basierter Browser** (Chrome, Chromium, Edge)  
  Web Serial ist **nicht** in Firefox oder Safari verfügbar.
- Arduino Nano 33 BLE Sense per USB verbunden, streamt Daten wie oben beschrieben.
- Unter Linux Mint (Snap-Chromium): `sudo snap connect chromium:raw-usb`

---

## Installation

```bash
npm install
```

---

## Starten

```bash
npm start
```

Dann **http://localhost:3000** in Chromium öffnen.

1. **Connect serial** klicken und den Arduino Nano 33 BLE Sense auswählen.
2. Kalibrierung durchführen (Leerer Kasten → Volle Flasche → Leere Flasche).
3. Beide Classifier-Karten aktualisieren sich live.

---

## Edge Impulse WASM Export

Die Model-Dateien liegen in `public/model/`.  
Siehe [`public/model/MODEL_README.md`](public/model/MODEL_README.md) für Details.

1. Edge Impulse Studio → **Deployment** → **WebAssembly (browser / SIMD)** → **Build**.
2. ZIP herunterladen und entpacken.
3. Diese drei Dateien nach `public/model/` kopieren:
   - `edge-impulse-standalone.js`
   - `edge-impulse-standalone.wasm`
   - `run-impulse.js`

---

## Projektstruktur

```
KastenKenner/
├── package.json
├── server.js                          ← Express Static Server (Port 3000)
├── sketch_kastenkenner_model.ino.ino  ← Arduino Sketch für Nano 33 BLE Sense (TAL220B + NAU7802)
├── README.md                          ← diese Datei
└── public/
    ├── index.html         ← Haupt-UI
    ├── styles.css
    ├── app.js             ← Serial-Input, Model-Adapter, Flaschenzähler, Kalibrierungs-UI
    ├── hardcode.js        ← Gewichtsbasierter Classifier mit Zustandsautomat
    ├── chart.js           ← Rolling Canvas Chart
    └── model/
        ├── MODEL_README.md
        ├── edge-impulse-standalone.js
        ├── edge-impulse-standalone.wasm
        └── run-impulse.js
```

---

## Lizenz

MIT
