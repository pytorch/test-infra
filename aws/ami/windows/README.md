# Building Windows AMIs

Windows AMIs can be built using packer (in this directory) with:

```
packer build windows.json
```

They can be found under `us-east-1` with the name prefix of **Windows 2019 GHA CI - {{timestamp}}**
