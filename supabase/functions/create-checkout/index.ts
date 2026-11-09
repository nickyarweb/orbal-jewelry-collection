// Creates a Stripe Checkout page for the items in the visitor's cart.
// Prices and stock are always read from the database here, never trusted from the browser.
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://orbaljewelrycollection.com").replace(/\/$/, "");
const ALLOWED_ORIGINS = [SITE_URL, SITE_URL.replace("https://", "https://www."), "http://localhost:8000", "http://127.0.0.1:8000"];

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { httpClient: Stripe.createFetchHttpClient() });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// Countries Stripe can ship to, used when the customer picks "Outside the USA".
const WORLD = ["AC","AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AT","AU","AW","AX","AZ","BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ","CA","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CV","CW","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE","EG","EH","ER","ES","ET","FI","FJ","FK","FO","FR","GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY","HK","HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IS","IT","JE","JM","JO","JP","KE","KG","KH","KI","KM","KN","KR","KW","KY","KZ","LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY","MA","MC","MD","ME","MF","MG","MK","ML","MM","MN","MO","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA","NC","NE","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG","PH","PK","PL","PM","PN","PR","PS","PT","PY","QA","RE","RO","RS","RU","RW","SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SZ","TA","TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT","TV","TW","TZ","UA","UG","UY","UZ","VA","VC","VE","VG","VN","VU","WF","WS","XK","YE","YT","ZA","ZM","ZW","ZZ"];

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : SITE_URL;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function reply(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405, origin);

  let body: { items?: { id: string; qty: number }[]; region?: string };
  try { body = await req.json(); } catch { return reply({ error: "Invalid request." }, 400, origin); }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length < 1 || items.length > 20) return reply({ error: "Your cart is empty." }, 400, origin);
  for (const it of items) {
    if (!UUID.test(String(it.id)) || !Number.isInteger(it.qty) || it.qty < 1 || it.qty > 10) {
      return reply({ error: "Something in your cart is not valid. Please refresh the page." }, 400, origin);
    }
  }
  const region = body.region === "world" ? "world" : "us";

  const { data: settings } = await db.from("store_settings").select("*").eq("id", 1).single();
  if (!settings?.store_open) return reply({ error: "The shop is closed right now. Please check back soon." }, 409, origin);

  const ids = [...new Set(items.map((i) => i.id))];
  const { data: products, error } = await db.from("products").select("id,name,price_cents,stock,images,active").in("id", ids);
  if (error) return reply({ error: "Could not load products. Please try again." }, 500, origin);

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  let subtotal = 0;
  for (const it of items) {
    const p = products?.find((x) => x.id === it.id);
    if (!p || !p.active) return reply({ error: "One item is no longer available. Please remove it from your cart." }, 409, origin);
    if (p.price_cents == null) return reply({ error: `“${p.name}” has no price yet. Please contact us.` }, 409, origin);
    if (p.stock < it.qty) {
      return reply({ error: p.stock === 0 ? `Sorry, “${p.name}” just sold out.` : `Only ${p.stock} left of “${p.name}”.` }, 409, origin);
    }
    subtotal += p.price_cents * it.qty;
    const image = (p.images ?? []).find((u: string) => u.startsWith("https://"));
    lineItems.push({
      quantity: it.qty,
      price_data: {
        currency: settings.currency,
        unit_amount: p.price_cents,
        product_data: { name: p.name, ...(image ? { images: [image] } : {}), metadata: { product_id: p.id } },
      },
    });
  }

  const free = settings.free_shipping_over_cents != null && subtotal >= settings.free_shipping_over_cents;
  const shippingAmount = free ? 0 : region === "world" ? settings.shipping_world_cents : settings.shipping_us_cents;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: (region === "world" ? WORLD : ["US"]) as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] },
      shipping_options: [{
        shipping_rate_data: {
          type: "fixed_amount",
          display_name: free ? "Free shipping" : region === "world" ? "International shipping" : "USA shipping",
          fixed_amount: { amount: shippingAmount, currency: settings.currency },
        },
      }],
      phone_number_collection: { enabled: true },
      billing_address_collection: "auto",
      success_url: `${SITE_URL}/thanks/?order={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/#collection`,
      metadata: { region },
    });
    return reply({ url: session.url }, 200, origin);
  } catch (e) {
    console.error("stripe error", e);
    return reply({ error: "Payment could not start. Please try again in a minute." }, 502, origin);
  }
});
