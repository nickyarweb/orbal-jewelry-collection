-- ORBAL Jewelry Collection store database
-- Tables: products, orders, customers, store_settings, admins
-- Security: visitors can only READ active products and the public store settings.
-- Everything else (orders, customers, editing products) is admin-only.
-- Orders are written only by the stripe-webhook function (service role), never by visitors.

-- ---------- Admins ----------
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create policy "admins can see admins" on public.admins
  for select to authenticated using (public.is_admin());

-- ---------- Store settings (one row) ----------
create table if not exists public.store_settings (
  id int primary key default 1 check (id = 1),
  currency text not null default 'usd',
  shipping_us_cents int not null default 500 check (shipping_us_cents >= 0),
  shipping_world_cents int not null default 2000 check (shipping_world_cents >= 0),
  free_shipping_over_cents int check (free_shipping_over_cents is null or free_shipping_over_cents >= 0),
  store_open boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.store_settings (id) values (1) on conflict (id) do nothing;
alter table public.store_settings enable row level security;
create policy "anyone can read settings" on public.store_settings
  for select to anon, authenticated using (true);
create policy "admins can update settings" on public.store_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Products ----------
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  category text not null default 'necklace'
    check (category in ('necklace', 'earring', 'bracelet', 'hand', 'ring', 'set', 'other')),
  price_cents int check (price_cents is null or price_cents >= 50),
  stock int not null default 1 check (stock >= 0),
  images text[] not null default '{}',
  active boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists products_active_sort on public.products (active, sort_order);
alter table public.products enable row level security;
create policy "anyone can read active products" on public.products
  for select to anon, authenticated using (active or public.is_admin());
create policy "admins can insert products" on public.products
  for insert to authenticated with check (public.is_admin());
create policy "admins can update products" on public.products
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins can delete products" on public.products
  for delete to authenticated using (public.is_admin());

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- ---------- Customers ----------
create table if not exists public.customers (
  email text primary key,
  name text,
  phone text,
  marketing_ok boolean not null default false,
  orders_count int not null default 0,
  total_spent_cents int not null default 0,
  first_order_at timestamptz,
  last_order_at timestamptz
);
alter table public.customers enable row level security;
create policy "admins can read customers" on public.customers
  for select to authenticated using (public.is_admin());
create policy "admins can update customers" on public.customers
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Orders ----------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity,
  stripe_session_id text not null unique,
  status text not null default 'paid' check (status in ('paid', 'shipped', 'cancelled', 'refunded')),
  customer_email text,
  customer_name text,
  customer_phone text,
  shipping_address jsonb,
  items jsonb not null,            -- [{product_id, name, qty, price_cents}]
  subtotal_cents int not null default 0,
  shipping_cents int not null default 0,
  total_cents int not null default 0,
  currency text not null default 'usd',
  tracking_number text,
  notes text,
  created_at timestamptz not null default now(),
  shipped_at timestamptz
);
create index if not exists orders_created on public.orders (created_at desc);
alter table public.orders enable row level security;
create policy "admins can read orders" on public.orders
  for select to authenticated using (public.is_admin());
create policy "admins can update orders" on public.orders
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Record a paid order (called only by the webhook with the service role) ----------
-- Saves the order, lowers stock, and updates the customer list in one transaction.
-- Safe to call twice for the same Stripe session (it does nothing the second time).
create or replace function public.record_paid_order(
  p_session_id text,
  p_email text,
  p_name text,
  p_phone text,
  p_address jsonb,
  p_items jsonb,
  p_subtotal int,
  p_shipping int,
  p_total int,
  p_currency text,
  p_marketing_ok boolean
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_item jsonb;
begin
  select id into v_id from orders where stripe_session_id = p_session_id;
  if v_id is not null then
    return v_id;
  end if;

  insert into orders (stripe_session_id, customer_email, customer_name, customer_phone,
                      shipping_address, items, subtotal_cents, shipping_cents, total_cents, currency)
  values (p_session_id, lower(p_email), p_name, p_phone, p_address, p_items,
          p_subtotal, p_shipping, p_total, p_currency)
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    update products
       set stock = greatest(stock - coalesce((v_item->>'qty')::int, 1), 0)
     where id = (v_item->>'product_id')::uuid;
  end loop;

  if p_email is not null then
    insert into customers (email, name, phone, marketing_ok, orders_count, total_spent_cents, first_order_at, last_order_at)
    values (lower(p_email), p_name, p_phone, coalesce(p_marketing_ok, false), 1, p_total, now(), now())
    on conflict (email) do update
      set name = coalesce(excluded.name, customers.name),
          phone = coalesce(excluded.phone, customers.phone),
          marketing_ok = customers.marketing_ok or excluded.marketing_ok,
          orders_count = customers.orders_count + 1,
          total_spent_cents = customers.total_spent_cents + excluded.total_spent_cents,
          last_order_at = now();
  end if;

  return v_id;
end;
$$;
revoke all on function public.record_paid_order(text, text, text, text, jsonb, jsonb, int, int, int, text, boolean) from public, anon, authenticated;

-- ---------- Product photo storage ----------
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

create policy "anyone can view product images" on storage.objects
  for select to anon, authenticated using (bucket_id = 'product-images');
create policy "admins can upload product images" on storage.objects
  for insert to authenticated with check (bucket_id = 'product-images' and public.is_admin());
create policy "admins can update product images" on storage.objects
  for update to authenticated using (bucket_id = 'product-images' and public.is_admin());
create policy "admins can delete product images" on storage.objects
  for delete to authenticated using (bucket_id = 'product-images' and public.is_admin());

-- ---------- Starting products (prices are set later in the admin page) ----------
insert into public.products (name, description, category, price_cents, stock, images, sort_order)
select * from (values
  ('Afghan Choker & Hand Chain Set', 'Layered silver-tone choker with red stones and a matching hand chain.', 'set', null::int, 1, array['https://orbaljewelrycollection.com/images/post8.jpg'], 10),
  ('Afghan Hoop Earrings', 'Large statement hoops with a red center stone, red and green stones and tiny bells.', 'earring', null, 1, array['https://orbaljewelrycollection.com/images/earrings.jpg', 'https://orbaljewelrycollection.com/images/earrings-collage.jpg'], 20),
  ('Afghan Colorful Choker Set', 'Choker with red, green and blue stones and coin drops, with matching earrings.', 'set', null, 1, array['https://orbaljewelrycollection.com/images/colorful-set.jpg'], 30),
  ('Afghan Jeweled Cuff', 'Wide gold-tone cuff with colorful stones.', 'bracelet', null, 1, array['https://orbaljewelrycollection.com/images/post12.jpg'], 40),
  ('Afghan Red Stone Cuff', 'Wide silver-tone cuff bracelet with a long red stone and a detailed pattern.', 'bracelet', null, 1, array['https://orbaljewelrycollection.com/images/red-stone.jpg'], 50),
  ('Afghan Gold Statement Necklace', 'Bold gold-tone necklace with coin details and a round pendant.', 'necklace', null, 1, array['https://orbaljewelrycollection.com/images/post10.jpg'], 60),
  ('Afghan Bridal Set', 'Choker and hand chain with red stones. Perfect for weddings and Eid.', 'set', null, 1, array['https://orbaljewelrycollection.com/images/post7.jpg'], 70),
  ('Afghan Triangle Necklace', 'Antique-style necklace with three triangle pendants.', 'necklace', null, 1, array['https://orbaljewelrycollection.com/images/post9.jpg'], 80),
  ('Afghan Blue Stone Cuffs', 'Wide silver-tone cuffs with deep blue stones and small red accents.', 'bracelet', null, 1, array['https://orbaljewelrycollection.com/images/blue-cuffs.jpg', 'https://orbaljewelrycollection.com/images/blue-cuffs-2.jpg'], 90)
) as v(name, description, category, price_cents, stock, images, sort_order)
where not exists (select 1 from public.products);
