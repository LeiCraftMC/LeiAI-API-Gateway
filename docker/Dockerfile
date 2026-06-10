FROM debian:stable-slim

RUN apt-get update && apt-get install -y curl ca-certificates openssl tar bash gpg

WORKDIR /opt/ai-api-load-balancer

COPY ./build/bin/ai-api-load-balancer-linux-x64-baseline /usr/local/bin/ai-api-load-balancer

RUN chmod u+x /usr/local/bin/ai-api-load-balancer

EXPOSE 3000/tcp

ENTRYPOINT ["/usr/local/bin/ai-api-load-balancer"]
