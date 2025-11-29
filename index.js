// proxy-server.js
const express = require('express');
const fetch = require('node-fetch'); // 需在 Dockerfile 里安装
const app = express();

function logError(req, message) {
    console.error(
        `${message}, clientIp: ${req.ip}, user-agent: ${req.headers['user-agent']}, url: ${req.originalUrl}`
    );
}

function createNewRequest(req, url, proxyHostname, originHostname) {
    const newRequestHeaders = { ...req.headers };
    Object.keys(newRequestHeaders).forEach(key => {
        const value = newRequestHeaders[key];
        if (typeof value === 'string' && value.includes(originHostname)) {
            newRequestHeaders[key] = value.replace(
                new RegExp(`(?<!\\.)\\b${originHostname}\\b`, 'g'),
                proxyHostname
            );
        }
    });
    return { headers: newRequestHeaders };
}

function setResponseHeaders(originalHeaders, proxyHostname, originHostname, DEBUG) {
    const newHeaders = {};
    for (const [key, value] of Object.entries(originalHeaders)) {
        if (typeof value === 'string' && value.includes(proxyHostname)) {
            newHeaders[key] = value.replace(
                new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, 'g'),
                originHostname
            );
        } else {
            newHeaders[key] = value;
        }
    }
    if (DEBUG) delete newHeaders['content-security-policy'];

    // Docker Hub特定处理
    if (newHeaders['www-authenticate'] && newHeaders['www-authenticate'].includes('auth.docker.io/token')) {
        newHeaders['www-authenticate'] = newHeaders['www-authenticate'].replace(
            'auth.docker.io/token', originHostname + '/token'
        );
    }
    return newHeaders;
}

async function replaceResponseText(body, proxyHostname, pathnameRegex, originHostname) {
    if (pathnameRegex) {
        pathnameRegex = pathnameRegex.replace(/^\^/, '');
        return body.replace(
            new RegExp(`((?<!\\.)\\b${proxyHostname}\\b)(${pathnameRegex})`, 'g'),
            `${originHostname}$2`
        );
    } else {
        return body.replace(
            new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, 'g'),
            originHostname
        );
    }
}

// 简易nginx伪装页
function nginx() {
    return `
<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p>
<p><em>Thank you for using nginx.</em></p>
</body>
</html>
    `;
}

// 统一处理所有路由
app.use(async (req, res) => {
    // ====== 配置项 ======
    let {
        PROXY_HOSTNAME = "registry-1.docker.io",
        PROXY_PROTOCOL = "https",
        PATHNAME_REGEX = "",
        UA_WHITELIST_REGEX = "",
        UA_BLACKLIST_REGEX = "",
        URL302 = "",
        IP_WHITELIST_REGEX = "",
        IP_BLACKLIST_REGEX = "",
        REGION_WHITELIST_REGEX = "",
        REGION_BLACKLIST_REGEX = "",
        DEBUG = false,
    } = process.env;

    DEBUG = String(DEBUG) === "true";

    // 取请求的 Host
    const url = new URL(req.protocol + "://" + req.get('host') + req.originalUrl);
    const originHostname = url.hostname;

    // 兼容Docker Hub API特殊规则
    if (url.pathname.includes("/token")) {
        PROXY_HOSTNAME = "auth.docker.io";
    } else if (url.pathname.includes("/search")) {
        PROXY_HOSTNAME = "index.docker.io";
    }

    // UA、IP等白黑名单判断
    if (
        !PROXY_HOSTNAME ||
        (PATHNAME_REGEX && !new RegExp(PATHNAME_REGEX).test(url.pathname)) ||
        (UA_WHITELIST_REGEX && !new RegExp(UA_WHITELIST_REGEX).test((req.headers['user-agent'] || "").toLowerCase())) ||
        (UA_BLACKLIST_REGEX && new RegExp(UA_BLACKLIST_REGEX).test((req.headers['user-agent'] || "").toLowerCase())) ||
        (IP_WHITELIST_REGEX && !new RegExp(IP_WHITELIST_REGEX).test(req.ip)) ||
        (IP_BLACKLIST_REGEX && new RegExp(IP_BLACKLIST_REGEX).test(req.ip))
        // REGION 判断略过（Cloudflare Worker 特有头）
    ) {
        logError(req, "Invalid");
        if (URL302) {
            return res.redirect(302, URL302);
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(nginx());
    }

    // 组装目标url
    url.host = PROXY_HOSTNAME;
    url.protocol = PROXY_PROTOCOL + ":";

    // 构造 headers
    const fetchOptions = {
        method: req.method,
        headers: createNewRequest(req, url, PROXY_HOSTNAME, originHostname).headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req
    };

    try {
        // 代理请求
        const upstreamRes = await fetch(url.toString(), fetchOptions);

        // 复制headers
        const originalHeaders = {};
        upstreamRes.headers.forEach((value, key) => { originalHeaders[key] = value; });
        const newResponseHeaders = setResponseHeaders(originalHeaders, PROXY_HOSTNAME, originHostname, DEBUG);

        // 内容判断
        const contentType = newResponseHeaders['content-type'] || "";
        let body;
        if (contentType.includes("text/")) {
            body = await upstreamRes.text();
            body = await replaceResponseText(body, PROXY_HOSTNAME, PATHNAME_REGEX, originHostname);
        } else {
            body = upstreamRes.body;
        }

        // 返回响应
        res.status(upstreamRes.status);
        for (const [k, v] of Object.entries(newResponseHeaders)) {
            res.setHeader(k, v);
        }
        if (body instanceof Buffer || typeof body === 'string') {
            res.send(body);
        } else {
            body.pipe(res);
        }
    } catch (error) {
        logError(req, `Fetch error: ${error.message}`);
        res.status(500).send("Internal Server Error");
    }
});

// 监听端口（可用环境变量 PORT 配置，默认8080）
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Proxy server started on port ${PORT}`);
});