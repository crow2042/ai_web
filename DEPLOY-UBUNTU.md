# Ubuntu 部署说明

## 首次安装 Node.js 20

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg unzip
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 上传并解压

部署包默认不包含 `data/`，这样更新网站时不会覆盖服务器上的配置和生成记录。

```bash
mkdir -p ~/ai-image-site
unzip -o ~/ai-image-site-deploy.zip -d ~/ai-image-site
cd ~/ai-image-site
```

如果是首次部署，启动后网站会自动创建 `data/config.json` 和记录文件。

## 启动测试

```bash
npm start
```

浏览器访问：

```text
http://服务器公网IP:3000
```

如果可以打开，按 `Ctrl+C` 停止临时运行。

## 后台常驻运行

```bash
sudo npm install -g pm2
cd ~/ai-image-site
pm2 start server.js --name ai-image-site
pm2 save
pm2 startup
```

`pm2 startup` 会输出一行 `sudo ...` 命令，复制执行一次即可设置开机自启。

## 后续更新网站

在 Windows 本机上传新包：

```powershell
scp C:\Users\v-wuchaoxin\Documents\Codex\2026-04-28\ai-prompt-api-css-admin-1596357\ai-image-site-deploy.zip ubuntu@124.222.55.237:~/
```

在服务器执行：

```bash
cd ~/ai-image-site
unzip -o ~/ai-image-site-deploy.zip -d ~/ai-image-site
pm2 restart ai-image-site
```

因为部署包不包含 `data/`，服务器上的 API 配置和生成记录会保留。

## 注意

- 部署后建议修改默认管理员密码。
- `data/config.json` 内含 API Key，不要公开这个目录。
- 当前可以先用 `http://IP:3000` 内部使用，正式长期使用建议配置域名和 HTTPS。
