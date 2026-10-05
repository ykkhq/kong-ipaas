# edi-gateway: partner credentials and local station keys.
path "ipaas/data/edi/*"     { capabilities = ["create", "read", "update", "delete"] }
path "ipaas/metadata/edi/*" { capabilities = ["read", "list", "delete"] }
path "ipaas/metadata/edi"   { capabilities = ["list"] }
