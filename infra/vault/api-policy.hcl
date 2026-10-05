# API: manage database connections.
path "ipaas/data/db/*"     { capabilities = ["create", "read", "update", "delete"] }
path "ipaas/metadata/db/*" { capabilities = ["read", "list", "delete"] }
path "ipaas/metadata/db"   { capabilities = ["list"] }
