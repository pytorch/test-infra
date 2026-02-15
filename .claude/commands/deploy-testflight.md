# Deploy TorchCI to TestFlight

## Via Fastlane (preferred)

```bash
cd ios

# Internal beta
fastlane ios beta

# External beta
fastlane ios external_beta
```

## Via xcodebuild (manual)

1. Bump `CURRENT_PROJECT_VERSION` in `ios/project.yml` (current: 73)
2. Regenerate project:
```bash
cd ios && xcodegen generate
```
3. Archive:
```bash
xcodebuild archive -project ios/TorchCI.xcodeproj -scheme TorchCI \
  -archivePath /tmp/TorchCI.xcarchive -destination 'generic/platform=iOS' -quiet
```
4. Export and upload:
```bash
cat > /tmp/ExportOptions.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>app-store-connect</string>
    <key>teamID</key><string>N324UX8D9M</string>
    <key>destination</key><string>upload</string>
</dict>
</plist>
PLIST

xcodebuild -exportArchive -archivePath /tmp/TorchCI.xcarchive \
  -exportOptionsPlist /tmp/ExportOptions.plist -exportPath /tmp/TorchCI-export \
  -allowProvisioningUpdates \
  -authenticationKeyPath ~/.private_keys/AuthKey_GA9T4G84AU.p8 \
  -authenticationKeyID GA9T4G84AU \
  -authenticationKeyIssuerID 39f22957-9a03-421a-ada6-86471b32ee9f
```
5. Clean up: `rm -rf /tmp/TorchCI.xcarchive /tmp/TorchCI-export /tmp/ExportOptions.plist`

## Notes
- Team ID: `N324UX8D9M`
- Bundle ID: `com.pytorch.torchci`
- This is a fork of pytorch/test-infra — push to fork, PR to upstream
- Build number is in `ios/project.yml` under CURRENT_PROJECT_VERSION
