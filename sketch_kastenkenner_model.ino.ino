#include <Wire.h>
#include <SparkFun_Qwiic_Scale_NAU7802_Arduino_Library.h>

NAU7802 scale;

#define SERIAL_BAUD 115200
#define SAMPLE_INTERVAL_MS 200

long zeroOffset = 0;
long previousRawDiff = 0;
bool firstSample = true;
unsigned long lastSample = 0;

long readAverageRaw(int samples = 5, int delayMs = 2) {
  int64_t sum = 0;
  for (int i = 0; i < samples; i++) {
    while (!scale.available()) {
      delay(1);
    }
    sum += scale.getReading();
    delay(delayMs);
  }
  return (long)(sum / samples);
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(2000);

  Wire.begin();

  if (!scale.begin()) {
    while (1) {
      delay(1000);
    }
  }

  scale.calibrateAFE();
  delay(1000);

  zeroOffset = readAverageRaw(50, 5);
}

void loop() {
  if (millis() - lastSample < SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSample = millis();

  long raw = readAverageRaw(3, 2);
  long rawDiff = raw - zeroOffset;

  long delta = 0;
  if (!firstSample) {
    delta = rawDiff - previousRawDiff;
  } else {
    firstSample = false;
  }

  previousRawDiff = rawDiff;

  char line[64];
  snprintf(line, sizeof(line), "%ld,%ld", rawDiff, delta);
  Serial.println(line);
}