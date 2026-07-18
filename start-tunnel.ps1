$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
& $cloudflared tunnel --protocol http2 --url http://localhost:3000 --no-autoupdate
