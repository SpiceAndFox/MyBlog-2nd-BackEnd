# 数据库自动备份

自动逻辑集中于仓库 `scripts/auto-backup/`，入口为该目录的 `backup.sh`，由同目录 `backup.py` 执行导出、校验、加密、上传和保留策略。仓库 `scripts/backup.sh` 及服务器 `/root/Blog/UpBack/backup.sh` 保留用户原来的手动备份脚本。自动逻辑只备份应用 `.env` 的 `DATABASE_URL` 指定的 PostgreSQL 数据库，包含聊天记录、记忆权威状态、快照和运行状态；不包含上传文件、应用 `.env`、数据库角色或 Git 仓库。

## 当前部署

- 自动脚本：`/root/Blog/UpBack/auto-backup/backup.sh` 和同目录 `backup.py`。
- 配置：`/root/Blog/UpBack/auto-backup/backup.conf.json`，按 `scripts/auto-backup/backup.conf.example.json` 创建。里面只有路径和保留数量。
- 密码：`/root/Blog/UpBack/auto-backup/backup-secrets.json`，内容为 `{"password":"自己设置的密码"}`，权限必须为 `600`，不要提交 Git 或上传云端。空密码会在导出数据库之前报错。
- 本地备份及调度状态：`/root/Blog/UpBack/auto-backup/data`，保留最近 4 份已上传成功的加密备份。
- 云端：`GoogleDrive:BlogBackup/automatic-v1`，保留最近 30 份完整备份。rclone 应使用自己 Google Cloud 项目中的 OAuth 客户端并重新授权，避免依赖共享客户端的项目配额。
- 云端每次只有一个 `pgbackup-v1-YYYYMMDDTHHMMSSZ-8位十六进制编号.dump.gpg` 文件。
- 本地每份备份放在对应 ID 的目录里，包含 `database.dump.gpg`、用于校验和重试的 `manifest.json`、上传成功凭据 `uploaded.json`。清单不上传云端。
- 已有历史备份及本次记忆恢复目录不参与自动清理。

## 调度与失败处理

`blog-database-backup.timer` 每分钟触发一次很轻的本地到期检查。只有到期或存在待重试工作时才备份数据库或联系云端：从最新本地备份的生成时间起，每 72 小时生成一次本地加密备份，最多约 1 分钟调度延迟，不使用会在月份交界处产生短间隔的 cron `*/3` 日期写法。

下一次本地到期时间持久化到 `state.json`，并从本地清单恢复，服务器重启后不会丢失。上传失败保留本地加密文件，每小时重试；即使云端持续故障或处于重试退避期，本地仍每 72 小时生成一份新快照，不会每分钟重复导出。待上传文件按生成时间顺序补传，每轮最多一份；旧文件补传成功不会把本地调度时间拨回过去。未上传成功的备份不清理，因此长期云端故障会增加本地磁盘占用。

本地导出或加密失败也按小时退避，独立于云端重试计时。状态中的 `local_last_error`、`local_retry_not_before` 记录本地失败，`last_error` 和 `retry_not_before` 记录最近错误及云端退避；`last_local_success` 与 `last_success` 分别表示最近生成和最近完成云端验证的备份。

执行顺序：`pg_dump -Fc` → 检查非空 → `pg_restore --file=/dev/null` 完整解码 → GPG 密码加密（AES-256）→ 以临时文件名上传密文 → 从云端回读全部密文并核对大小和 SHA-256 → 改为正式文件名 → 标记成功 → 清理超额备份。临时文件名为 `.pgbackup-v1-时间戳-编号.dump.gpg.uploading`，不计入完整备份。`pg_restore` 解码检查不等同于在空数据库执行恢复演练；首次启用前还应执行一次云端下载、解密和归档校验。

`flock` 防止手工运行和定时任务重叠。数据库密码经环境传给 PostgreSQL 工具；加密密码经标准输入传给 GPG，均不出现在命令参数或正常日志中。失败返回非零退出码并写入 systemd journal 和状态文件。此配置不向邮箱或聊天软件发送通知。

云端仅统计 `automatic-v1` 目录直接包含、非空且符合完整文件名 `pgbackup-v1-YYYYMMDDTHHMMSSZ-8位十六进制编号.dump.gpg` 的文件，按文件名中的 UTC 生成时间排序保留最近 30 份。这个命名格式专用于自动备份，请给其他文件使用不同名称。不会遍历或删除子目录。

本地仅统计 `data` 内符合对应 ID 格式、有有效校验清单和上传成功凭据的目录，保留最近 4 份；未上传成功的本地备份额外保留。

其他文件、仅前缀相似但不符合完整格式的文件、已有 `blog_*.dump.age` 都不计数、不删除。如果在某一份本地备份目录里另放文件，该整份目录会跳过清理，此时本地实际份数可能超过 4。清理逐个删除脚本自己的文件，不执行 `sync`、`purge` 或整个 Drive 的垃圾箱清空。Google Drive 的删除沿用 rclone 默认回收站行为；回收站中的旧文件不计入上述份数。[rclone Drive 文档](https://rclone.org/drive/#deleting-files)

## 查看与手工执行

```bash
~/Blog/UpBack/auto-backup/backup.sh --status
~/Blog/UpBack/auto-backup/backup.sh --force
systemctl status blog-database-backup.timer
journalctl -u blog-database-backup.service -n 50 --no-pager
```

没有参数时仅在到期或有待重试工作时执行。`--force` 跳过退避；若本地已经到期，先生成当前快照，再补传最早的待上传文件。若本地尚未到期且有待上传文件，仅补传；没有待上传文件时立即生成并上传新备份。停用自动备份：`systemctl disable --now blog-database-backup.timer`。

## 独立 Google OAuth 客户端

在自己的 Google Cloud 项目启用 Google Drive API，创建 Desktop app 类型的 OAuth 客户端。External 应用长期运行应使用 In production 状态；Testing 状态下，包含 Drive 权限的刷新令牌会在 7 天后过期。下载的客户端 JSON、rclone 配置及 token 都是私密配置，留在仓库外，不粘贴到聊天或日志中。[rclone 配置步骤](https://rclone.org/drive/#making-your-own-client-id)、[Google 令牌过期规则](https://developers.google.com/identity/protocols/oauth2#expiration)

先复制当前 rclone 配置到权限为 `600` 的私密候选文件，在候选配置的 `GoogleDrive` remote 设置新客户端，并重新进行浏览器授权，不能直接沿用旧 token。保持原 Google 账号及 `drive` scope，使新客户端能读取已有备份目录。使用候选配置验证目录可读，并用随机测试文件完成上传、下载 SHA-256 校验和改名；通过后再切换正式配置。测试只操作自己创建的唯一文件名，清理沿用 Drive 回收站，不运行 `sync` 或 `purge`。切换后补传积压备份，并验证最新备份能下载、解密和被 `pg_restore` 完整解码。

`scripts/auto-backup/migrate_drive_oauth.py` 提供分阶段操作：`prepare` 从下载的 Desktop 客户端 JSON 生成候选配置，移除旧 token，保留其他 remotes，不改正式配置；`check` 要求候选配置存在刷新令牌，确认能看到最后成功的备份，并执行完整小文件验证；`activate` 重新验证后，将正式配置保存为权限 `600` 的私密副本，再原子替换，并清除云端重试退避。验证阶段与定时备份共用本地锁。检查失败时只可能留下 `.oauth-check-随机编号` 测试文件，不改备份文件。

```bash
# client.json 与候选配置应保存在仓库外，目录权限为 700。
python3 migrate_drive_oauth.py prepare --config backup.conf.json --candidate /private/path/rclone-candidate.conf --client-json /private/path/client.json
rclone config reconnect GoogleDrive: --config /private/path/rclone-candidate.conf
python3 migrate_drive_oauth.py check --config backup.conf.json --candidate /private/path/rclone-candidate.conf
python3 migrate_drive_oauth.py activate --config backup.conf.json --candidate /private/path/rclone-candidate.conf
```

## 设置密码与读取备份

新备份使用配置文件中的密码，不需要公钥、私钥或密钥对。使用 `nano ~/Blog/UpBack/auto-backup/backup-secrets.json` 设置密码，然后执行 `chmod 600 ~/Blog/UpBack/auto-backup/backup-secrets.json`。密码不能包含换行；双引号或反斜杠需按 JSON 语法转义。服务器使用此文件实现无人值守加密，恢复时输入相同密码即可。请在服务器之外保留这个密码；以后修改密码，只影响新生成的备份，旧备份仍需要旧密码。

密码通过 `--passphrase-fd 0` 与 `--pinentry-mode loopback` 提供给 GPG；不使用命令行明文密码参数。[GnuPG 参数文档](https://www.gnupg.org/documentation/manuals/gnupg/GPG-Esoteric-Options.html)

```bash
# 从专用备份目录选择一份文件，下载到新的本地目录。
mkdir -m 700 ./restore-input
rclone copyto GoogleDrive:BlogBackup/automatic-v1/<backup-id>.dump.gpg ./restore-input/database.dump.gpg
# 交互输入该份备份生成时使用的密码。
gpg --output ./restore-input/database.dump --decrypt ./restore-input/database.dump.gpg
pg_restore --file=/dev/null ./restore-input/database.dump
```

若本地对应备份清单仍在，可以用其中的 `archive_sha256` 再核对解密后的文件；云端加密文件本身可凭密码独立解密，不依赖清单。真正恢复数据库时应先在独立数据库演练并明确目标库；不要直接覆盖正在运行的生产库。已有 `.dump.age` 历史备份仍通过 `age --decrypt` 和当时的原密码解密。

## 维护与测试

更新自动脚本时，将 `scripts/auto-backup/` 下的 `backup.sh` 和 `backup.py` 同步至服务器 `auto-backup/` 目录，实际配置和密码留在服务器；systemd unit 模板在 `scripts/auto-backup/systemd/`。不要覆盖父目录的手动 `backup.sh`。配置路径改变时同步修改 unit，再执行 `systemctl daemon-reload`。首次真实备份及下载解密校验通过后，用 `systemctl enable --now blog-database-backup.timer` 启用调度。

离线故障注入测试（不连接数据库或云端）：

```bash
python3 -m unittest discover -s test/backup -p 'test_*.py' -v
```
