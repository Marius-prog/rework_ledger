import "dotenv/config";
import Stripe from "stripe";
const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
const stripe = new Stripe(key);
const plans = [
  { name: "Starter", amount: 3900, lookup: "rework_ledger_starter" },
  { name: "Team", amount: 14900, lookup: "rework_ledger_team" },
  { name: "Business", amount: 49900, lookup: "rework_ledger_business" },
];
for (const p of plans) {
  const existing = await stripe.prices.list({ lookup_keys: [p.lookup] });
  if (existing.data.length) { console.log(`${p.name}: exists ${existing.data[0].id}`); continue; }
  const product = await stripe.products.create({ name: `Rework Ledger ${p.name}` });
  const price = await stripe.prices.create({
    product: product.id, unit_amount: p.amount, currency: "usd",
    recurring: { interval: "month" }, lookup_key: p.lookup,
  });
  console.log(`${p.name}: created ${price.id}`);
}
