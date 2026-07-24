<p align="center">
  <img src="docs/assets/meccha-camouflage-readme-banner-v151-1600w.jpg" alt="Meccha Camouflage demo" width="900" />
</p>

<p align="center">
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg" alt="License: GPL-3.0-or-later" /></a>
  <a href="#download"><img src="https://img.shields.io/badge/platform-Windows%2010%20%7C%20Windows%2011-0078D4?logo=windows&amp;logoColor=white" alt="Platform: Windows 10 and Windows 11" /></a>
</p>

<h1>
  <img src="resources/app-icons/icon.png" alt="Meccha Camouflage icon" width="36" />
  Meccha Camouflage
</h1>

A standalone Windows desktop tool for MECCHA CHAMELEON camouflage experiments.

## Download

Download the latest `meccha-camouflage.exe` from GitHub Releases:

- https://github.com/acentrist/MecchaCamouflage/releases/latest

## Usage

1. Start MECCHA CHAMELEON.
2. Start `meccha-camouflage.exe`.
3. Confirm the target process and bridge state in the app.
4. Press the saved paint hotkey.

Logs are written under:

```text
%LOCALAPPDATA%\MecchaCamouflage\versions\<version>\logs\
```

## Windows Security

If the log reports an error like the following, Windows Security has blocked a
runtime file:

```text
Bridge warmup failed: One or more errors occurred. (Operation did not complete successfully because the file contains a virus or potentially unwanted software.)
```

1. Open **Windows Security**.
2. Go to **Virus & threat protection** → **Manage settings**.
3. Scroll down to **Exclusions** and click **Add or remove exclusions**.
4. Click **Add an exclusion** → **Folder**.
5. Select the following folder:

```text
%LOCALAPPDATA%\MecchaCamouflage\
```

After adding the exclusion, restart MecchaCamouflage.

## Development

```bash
git clone https://github.com/acentrist/MecchaCamouflage.git
cd MecchaCamouflage
make run
```

## Contributors

[![Contributors](https://contrib.rocks/image?repo=acentrist/MecchaCamouflage)](https://github.com/acentrist/MecchaCamouflage/graphs/contributors)

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and the PR process.

## Security

Follow the disclosure process in [SECURITY.md](SECURITY.md).

## License

[GPL-3.0-or-later](LICENSE.txt) © Acentrist
