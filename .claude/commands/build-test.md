# Build and Test TorchCI

## iOS App

```bash
cd ios

# Generate project
xcodegen generate

# Build
xcodebuild build -project TorchCI.xcodeproj -scheme TorchCI \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=latest'

# Run tests (1756 unit tests)
xcodebuild test -project TorchCI.xcodeproj -scheme TorchCI \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=latest' \
  -only-testing:TorchCITests -quiet

# UI tests
xcodebuild test -project TorchCI.xcodeproj -scheme TorchCI \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=latest' \
  -only-testing:TorchCIUITests -quiet
```

## Via Fastlane

```bash
cd ios/fastlane
fastlane ios build
fastlane ios test
```

## HUD Web (torchci)

```bash
cd torchci
yarn install
yarn dev      # Dev server on localhost:3000
yarn build    # Production build
yarn test     # Jest tests
yarn lint     # ESLint
```

## Linting (all languages)

```bash
lintrunner run-all
```

## Notes
- iOS uses XcodeGen (regenerate after project.yml changes)
- Simulator: iPhone 16 Pro (this repo targets Xcode 16, not 26)
- Zero third-party dependencies in iOS app
- Fork workflow: push to wdvr/test-infra, PR to pytorch/test-infra
