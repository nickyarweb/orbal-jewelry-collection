// Stripe calls this after a payment succeeds.
// It checks Stripe's signature (so nobody can fake an order), then saves the order,
// lowers stock and updates the customer list in the database.
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { httpClient: Stripe.createFetchHttpClient() });
const crypto = Stripe.createSubtleCryptoProvider();
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const signature = req.headers.get("stripe-signature");
  const payload = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload, signature ?? "", Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "", undefined, crypto,
    );
  } catch (e) {
    console.error("bad signature", (e as Error).message);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return new Response("ignored", { status: 200 });
  }

  const session = await stripe.checkout.sessions.retrieve((event.data.object as Stripe.Checkout.Session).id);
  if (session.payment_status !== "paid") return new Response("not paid yet", { status: 200 });

  const lines = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100, expand: ["data.price.product"] });
  const items = lines.data.map((l) => {
    const product = l.price?.product as Stripe.Product | undefined;
    return {
      product_id: product?.metadata?.product_id ?? null,
      name: l.description,
      qty: l.quantity ?? 1,
      price_cents: l.price?.unit_amount ?? 0,
    };
  }).filter((i) => i.product_id);

  // deno-lint-ignore no-explicit-any
  const s = session as any;
  const shipping = s.collected_information?.shipping_details ?? s.shipping_details ?? null;
  const customer = session.customer_details;

  const { error } = await db.rpc("record_paid_order", {
    p_session_id: session.id,
    p_email: customer?.email ?? null,
    p_name: shipping?.name ?? customer?.name ?? null,
    p_phone: customer?.phone ?? null,
    p_address: shipping?.address ?? customer?.address ?? null,
    p_items: items,
    p_subtotal: session.amount_subtotal ?? 0,
    p_shipping: session.shipping_cost?.amount_total ?? 0,
    p_total: session.amount_total ?? 0,
    p_currency: session.currency ?? "usd",
    p_marketing_ok: s.consent?.promotions === "opt_in",
  });

  if (error) {
    console.error("could not save order", error);
    return new Response("save failed", { status: 500 }); // Stripe will retry
  }
  return new Response("ok", { status: 200 });
});
