FROM node:20-alpine

WORKDIR /app
COPY index.js .

RUN  chmod +x index.js &&\
     npm install express node-fetch

# 可选：设置默认环境变量（可被 docker run -e 覆盖）
ENV PROXY_HOSTNAME=registry-1.docker.io
ENV PROXY_PROTOCOL=https
ENV PORT=8080

EXPOSE 8080
CMD ["node", "index.js"]