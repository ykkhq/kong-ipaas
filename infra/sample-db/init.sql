-- Stub data for the Database node examples (Postgres 16).
CREATE TABLE customers (
  id         integer PRIMARY KEY,
  name       text NOT NULL,
  email      text NOT NULL UNIQUE,
  city       text NOT NULL,
  tier       text NOT NULL CHECK (tier IN ('gold', 'silver', 'bronze')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  sku   text PRIMARY KEY,
  name  text NOT NULL,
  price numeric(10, 2) NOT NULL,
  stock integer NOT NULL
);

CREATE TABLE orders (
  id          text PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  status      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id text NOT NULL REFERENCES orders (id),
  sku      text NOT NULL REFERENCES products (sku),
  qty      integer NOT NULL,
  PRIMARY KEY (order_id, sku)
);

INSERT INTO customers (id, name, email, city, tier) VALUES
  (1, 'Ada Lovelace', 'ada@example.com', 'London', 'gold'),
  (2, 'Grace Hopper', 'grace@example.com', 'New York', 'silver'),
  (3, 'Yukihiro Matsumoto', 'matz@example.com', 'Tokyo', 'gold'),
  (4, 'Alan Turing', 'alan@example.com', 'London', 'bronze');

INSERT INTO products (sku, name, price, stock) VALUES
  ('A-1', 'Widget', 19.99, 12),
  ('B-2', 'Gadget', 49.00, 0),
  ('C-3', 'Doohickey', 5.50, 140);

INSERT INTO orders (id, customer_id, status, created_at) VALUES
  ('o-100', 1, 'shipped', now() - interval '6 days'),
  ('o-101', 1, 'pending', now() - interval '1 day'),
  ('o-200', 2, 'delivered', now() - interval '20 days'),
  ('o-300', 3, 'pending', now() - interval '2 hours');

INSERT INTO order_items (order_id, sku, qty) VALUES
  ('o-100', 'A-1', 2), ('o-100', 'C-3', 10),
  ('o-101', 'B-2', 1),
  ('o-200', 'C-3', 3),
  ('o-300', 'A-1', 1), ('o-300', 'B-2', 2);

-- Application role db-access connects with (DML only, no DDL).
CREATE ROLE ipaas_app LOGIN PASSWORD 'app';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ipaas_app;
