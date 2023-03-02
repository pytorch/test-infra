# Changelog

All notable changes to this project will be documented in this file.

## [0.10.7] - 2023-03-02

### Bug Fixes

- Run clippy and rustfmt; fix issues ([#34](https://github.com/suo/lintrunner/issues/34)) ([b0e8be2](https://github.com/suo/lintrunner/commit/b0e8be295e5a0e959f36ea740b95780a9abe7400))
- Fix and enable rustfmt linter ([#35](https://github.com/suo/lintrunner/issues/35)) ([507d273](https://github.com/suo/lintrunner/commit/507d27314283fd5c6acede4e75800766921e358d))

### Features

- Enable setting default --merge-base-with values ([75ea9c0](https://github.com/suo/lintrunner/commit/75ea9c09cd6904e6e53170af0661fd3dcb39c9e9))

## [0.10.5] - 2023-01-19

### Bug Fixes

- Add a space to the severity on oneline format ([#30](https://github.com/suo/lintrunner/issues/30)) ([5120786](https://github.com/suo/lintrunner/commit/5120786d3a61bf9013563a126f61f9cb5727be1a))

## [0.10.2] - 2023-01-13

### Features

- Update the message format produced by `convert_to_sarif.py` ([#28](https://github.com/suo/lintrunner/issues/28)) ([b3370bf](https://github.com/suo/lintrunner/commit/b3370bff64ee5bdaad7faef89b4127c2d3b4f357))

## [0.10.1] - 2023-01-13

### Bug Fixes

- Allow --paths-cmd to run on Windows ([#23](https://github.com/suo/lintrunner/issues/23)) ([a1c4191](https://github.com/suo/lintrunner/commit/a1c4191575959974ce5b17269f624b17e93951a0))

## [0.10.0] - 2022-11-28

### Bug Fixes

- Typo in init_command doc ([#17](https://github.com/suo/lintrunner/issues/17)) ([fa8d7b3](https://github.com/suo/lintrunner/commit/fa8d7b32641e58c041e9f3bf15a4b26e1afff915))
- Path construction errors on Windows ([#19](https://github.com/suo/lintrunner/issues/19)) ([032bea6](https://github.com/suo/lintrunner/commit/032bea69f31f6ccfab5cb6670edfb5adb22f1840))

### Features

- A tool to convert json output to SARIF format ([#16](https://github.com/suo/lintrunner/issues/16)) ([1c991af](https://github.com/suo/lintrunner/commit/1c991affb15edac2bb67080e49bf0e5037b47e92))
- Add lint_message.name to oneline output ([#21](https://github.com/suo/lintrunner/issues/21)) ([84f3d34](https://github.com/suo/lintrunner/commit/84f3d34c6db340bdbbe63a4d192004f17769758b))

### Testing

- Fix linux ci ([c443387](https://github.com/suo/lintrunner/commit/c443387ff9a42a6f8c9b0e8add04220d2fea46a1))

## [0.9.3] - 2022-09-23

### Bug Fixes

- Don't check files that were deleted/moved in working tree ([0fbb2f3](https://github.com/suo/lintrunner/commit/0fbb2f3d01a08088606ee6650e98d9db9b0b7b3a))

### Testing

- Add unit test for trailing whitespace ([bbbcffd](https://github.com/suo/lintrunner/commit/bbbcffd7d095b16fc831fe48c163b4805e6a9aa0))
- Add missing snapshot ([9fda576](https://github.com/suo/lintrunner/commit/9fda576f330392c244527defb6e80250663744c6))

## [0.9.2] - 2022-05-11

### Bug Fixes

- Add more runtime info to logs ([80e78de](https://github.com/suo/lintrunner/commit/80e78dee128f834f4f696c652bcec32a4f0e0d1c))

### Features

- Add --all-files command ([3d64ad3](https://github.com/suo/lintrunner/commit/3d64ad33ca94172ee27830fb772c35d469b41028))

## [0.9.1] - 2022-05-11

### Features

- Add --tee-json option ([5978ec0](https://github.com/suo/lintrunner/commit/5978ec0e47f38bd0252c3f5afa02d27314edd875))

## [0.9.0] - 2022-05-10

### Bug Fixes

- Add --version command-line arg ([7932c44](https://github.com/suo/lintrunner/commit/7932c44d80279e54b67e02d256b356104ba4bcc2))
- Escape command-line args in log ([1018103](https://github.com/suo/lintrunner/commit/10181032e2093bcf0cb233300b982da459a71975))
- Error if duplicate linters found ([89064c1](https://github.com/suo/lintrunner/commit/89064c1f808d7e76ecc183c182b9c1ac4d765704))
- Escape linter initializer in logs ([0a0f0ec](https://github.com/suo/lintrunner/commit/0a0f0ec1d86b02f77a680ad8e4560ed80219b849))
- Properly ignore current run on `rage -i` ([#6](https://github.com/suo/lintrunner/issues/6)) ([e4989eb](https://github.com/suo/lintrunner/commit/e4989ebe598d7268d4ae715484ec21a57aadd426))
- Show milliseconds in rage run timestamp ([9780a2b](https://github.com/suo/lintrunner/commit/9780a2b8774b3c6e52b29414435a038840a3aabf))

### Documentation

- Update changelog ([82c3335](https://github.com/suo/lintrunner/commit/82c33359f0cde758e7153d4ba450751afbc6c6c8))

### Features

- Add rage command for bug reporting ([bb80fef](https://github.com/suo/lintrunner/commit/bb80fef49fabad5558e77786e157b4ea822d0f23))

## [0.8.0] - 2022-05-02

### Bug Fixes

- Add severity to oneline message ([14495be](https://github.com/suo/lintrunner/commit/14495be590d1b8c223a07f59ccdb6600d22e92c4))
- Unify output controlling commands into --output ([8b95e7b](https://github.com/suo/lintrunner/commit/8b95e7b76c65dc4187b17b9851ce902aebc58944))

### Documentation

- Improve help message ([0630560](https://github.com/suo/lintrunner/commit/06305606f9d840610487a9b7dff9a159a05fb8d1))

### Features

- Warn if init seems out of date ([4050dd7](https://github.com/suo/lintrunner/commit/4050dd7fe883c419e0af110a7d2c6887b6ba08f0))
- Format command ([bf7925d](https://github.com/suo/lintrunner/commit/bf7925df7b1aac0265e3bf88ef8ca05d720e0560))

### Testing

- Add integration test for init warnings ([9c75f29](https://github.com/suo/lintrunner/commit/9c75f293cdccbd662f922548861b277c70f9d14d))
- Add integration test for dryrun error on init config ([88738ca](https://github.com/suo/lintrunner/commit/88738ca299179588e9abae6b8265c8287270edb6))

### Build

- Run cargo upgrade ([0241c01](https://github.com/suo/lintrunner/commit/0241c01630187ce3817ee1964f858ebc7b85d10a))

## [0.7.0] - 2022-04-15

### Features

- Add --oneline arg for compact lint rendering ([a0a9e87](https://github.com/suo/lintrunner/commit/a0a9e878781a2ead70ff7bfc94064275eeb79020))

## [0.6.2] - 2022-04-15

### Bug Fixes

- Do not allow * to match across path segments ([382413a](https://github.com/suo/lintrunner/commit/382413aa40edf2dead74fd9f25fdd01bac00bd80))

### Testing

- Add test for deleted files with --revision specified ([19c6fee](https://github.com/suo/lintrunner/commit/19c6fee0d11096c4ba7e7182fd3178b170cddb10))

## [0.6.1] - 2022-04-15

### Bug Fixes

- Correct order of arguments while gathering files to lint ([9c2093d](https://github.com/suo/lintrunner/commit/9c2093d4dace6e3570cad9bc5b363e0b3fc50b3c))

### Documentation

- Update install instructions ([a3095fd](https://github.com/suo/lintrunner/commit/a3095fde2edacb0dba93250cfca35f2000c4c009))
- Add --merge-base-with to readme ([8d51a11](https://github.com/suo/lintrunner/commit/8d51a117e833211ef275355d27c64eacab40cbce))

<!-- generated by git-cliff -->
