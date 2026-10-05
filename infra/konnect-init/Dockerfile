FROM alpine:3.21
RUN apk add --no-cache bash curl jq openssl
COPY bootstrap.sh /bootstrap.sh
RUN chmod +x /bootstrap.sh
ENTRYPOINT ["/bootstrap.sh"]
