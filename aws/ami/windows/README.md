# Building Windows AMIs

Windows AMIs can be built using packer (in this directory) with:

To just test builds:
```
packer build .
```

To create new AMIs:
```
packer build -var 'skip_create_ami=false' .
```

They can be found under `us-east-1`  and `us-east-2` with the name prefix of **Windows 2019 GHA CI - {{timestamp}}**
