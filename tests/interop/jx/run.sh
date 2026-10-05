#!/bin/sh
# JX手順 interop. Needs the stack running (docker compose up -d).
#  A: jx_client (Ruby/Savon, https://github.com/Narazaka/jx_client) as client -> our JX server
#  B: our JX client -> a JAX-WS server generated from the official 2007 WSDL (see server/)
set -e
cd "$(dirname "$0")"
NET=${NET:-ipaas_default}
status=0
echo "== A: jx_client -> edi-gateway JX server"
# Savon 2.12 (jx_client's dependency) needs Rack 2, Nori 2.6 (String#snakecase) and ActiveSupport's blank?.
docker run --rm --network $NET -v "$PWD:/t" ruby:3.3-slim sh -c '
  gem install rack -v "~> 2.2" --no-document >/dev/null 2>&1
  gem install activesupport -v "~> 7.1" --no-document >/dev/null 2>&1
  gem install nori -v "~> 2.6.0" --no-document >/dev/null 2>&1
  gem install jx_client -v 0.1.1 --no-document >/dev/null 2>&1
  ruby -e "gem \"rack\", \"~> 2.2\"; gem \"nori\", \"~> 2.6.0\"; load \"/t/jx_client_test.rb\""' || status=1
[ -x server/run.sh ] && { echo "== B: edi-gateway JX client -> JAX-WS server from the official WSDL"; server/run.sh || status=1; }
exit $status
