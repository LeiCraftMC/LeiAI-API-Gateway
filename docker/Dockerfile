FROM debian:stable-slim

RUN apt-get update && apt-get install -y curl ca-certificates openssl tar bash gpg

WORKDIR /opt/leiai-api-gateway

COPY ./build/bin/leiai-api-gateway-linux-x64-baseline /usr/local/bin/leiai-api-gateway

RUN chmod u+x /usr/local/bin/leiai-api-gateway

EXPOSE 12117/tcp

ENV LAG_CONFIG_BASE_DIR=/app/config

ENTRYPOINT ["/usr/local/bin/leiai-api-gateway"]
