import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@14";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-04-10",
});

const SUPABASE_URL             = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

serve(async (req) => {
  const signature    = req.headers.get("stripe-signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

  // ── Verify Stripe signature ──────────────────────────────
  let event: Stripe.Event;
  try {
    const body = await req.text();
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Handle events ────────────────────────────────────────
  switch (event.type) {

    // User completes checkout → upgrade tier
    case "checkout.session.completed": {
      const session    = event.data.object as Stripe.Checkout.Session;
      const email      = session.customer_details?.email ?? session.customer_email;
      const tier       = session.metadata?.tier;          // 'pro' or 'label'
      const customerId = session.customer as string;

      console.log(`checkout.session.completed — email: ${email}, tier: ${tier}`);

      if (!email || !tier) {
        console.warn("Missing email or tier metadata. Skipping.");
        break;
      }

      // Look up the user by email in dj_profiles
      const { data: profile, error: lookupErr } = await admin
        .from("dj_profiles")
        .select("id")
        .eq("email", email)
        .maybeSingle();

      if (lookupErr || !profile) {
        console.error("User not found for email:", email, lookupErr?.message);
        break;
      }

      const { error: updateErr } = await admin
        .from("dj_profiles")
        .update({ tier, stripe_customer_id: customerId })
        .eq("id", profile.id);

      if (updateErr) {
        console.error("Failed to update tier:", updateErr.message);
      } else {
        console.log(`✓ Upgraded ${email} to ${tier}`);
      }
      break;
    }

    // Subscription cancelled → downgrade to free
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId   = subscription.customer as string;

      console.log(`customer.subscription.deleted — customer: ${customerId}`);

      const { error } = await admin
        .from("dj_profiles")
        .update({ tier: "free", stripe_customer_id: null })
        .eq("stripe_customer_id", customerId);

      if (error) {
        console.error("Failed to downgrade tier:", error.message);
      } else {
        console.log(`✓ Downgraded customer ${customerId} to free`);
      }
      break;
    }

    // Subscription updated (e.g. plan swap Pro ↔ Label)
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId   = subscription.customer as string;

      // Only act on active subscriptions
      if (subscription.status !== "active") break;

      // Determine new tier from price metadata if set, otherwise skip
      const priceId   = subscription.items.data[0]?.price?.id ?? "";
      const priceMeta = subscription.items.data[0]?.price?.metadata?.tier ?? "";

      if (!priceMeta) {
        console.log("No tier metadata on price, skipping subscription.updated");
        break;
      }

      console.log(`customer.subscription.updated — customer: ${customerId}, tier: ${priceMeta}`);

      const { error } = await admin
        .from("dj_profiles")
        .update({ tier: priceMeta })
        .eq("stripe_customer_id", customerId);

      if (error) {
        console.error("Failed to update tier on subscription update:", error.message);
      } else {
        console.log(`✓ Updated customer ${customerId} to tier: ${priceMeta}`);
      }
      break;
    }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
});
