# Building Windows AMIs

Windows AMIs can be built using packer (in this directory) with:

```
packer build windows.pkr.hcl
```

They can be found under `us-east-1`  and `us-east-2` with the name prefix of **Windows 2019 GHA CI - {{timestamp}}**
