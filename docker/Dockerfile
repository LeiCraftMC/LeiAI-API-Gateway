FROM debian:stable-slim

RUN apt-get update && apt-get install -y curl ca-certificates openssl tar bash gpg

WORKDIR /opt/leiai-api-gateway

COPY ./build/bin/leiai-api-gateway-linux-x64-baseline /usr/local/bin/leiai-api-gateway

RUN chmod u+x /usr/local/bin/leiai-api-gateway

EXPOSE 3000/tcp

ENTRYPOINT ["/usr/local/bin/leiai-api-gateway"]
