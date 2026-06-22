# Kotlin/Android Verification Commands

## 1. Build

```bash
./gradlew assembleDebug 2>&1 | tail -30
```

## 2. Lint

```bash
./gradlew lint 2>&1 | head -30
```

## 3. Tests (JVM)

```bash
./gradlew test 2>&1 | tail -50
```

## 4. Security Scan

```bash
grep -rn "api_key\|apiKey\|API_KEY" --include="*.kt" app/src/ 2>/dev/null | head -10
grep -rn "sk-\|key-" --include="*.kt" app/src/ 2>/dev/null | head -10
```
