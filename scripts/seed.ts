import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function seed() {
  console.log("Seeding customers...");

  const { data: customers, error: custErr } = await supabase
    .from("customers")
    .insert([
      {
        name: "Amaka Osei",
        email: "amaka@bridalcouture.ng",
        company: "Bridal Couture Lagos",
        phone: "+234 801 234 5678",
        notes: "High-value client. Prefers WhatsApp updates over email.",
      },
      {
        name: "Tunde Adeyemi",
        email: "tunde@constructgroup.com",
        company: "Construct Group Nigeria",
        phone: "+234 802 345 6789",
        notes: "Enterprise account. Decision maker for 3 subsidiary brands.",
      },
      {
        name: "Zara Musa",
        email: "zara@zaraevents.co",
        company: "Zara Events",
        phone: "+234 803 456 7890",
        notes: "Event planning firm. Recurring quarterly retainer.",
      },
    ])
    .select();

  if (custErr) {
    console.error("Customer seed failed:", custErr);
    return;
  }

  console.log(`Seeded ${customers.length} customers`);
  console.log("Seeding leads...");

  const { error: leadErr } = await supabase.from("leads").insert([
    {
      name: "Emeka Nwosu",
      email: "emeka@freshbrandng.com",
      company: "FreshBrand Nigeria",
      source: "cold-outreach",
      status: "new",
    },
    {
      name: "Fatima Al-Hassan",
      email: "fatima@luxestays.ng",
      company: "Luxe Stays",
      source: "referral",
      status: "contacted",
    },
    {
      customer_id: customers[0].id,
      name: "Amaka Osei",
      email: "amaka@bridalcouture.ng",
      company: "Bridal Couture Lagos",
      source: "inbound",
      status: "qualified",
    },
  ]);

  if (leadErr) {
    console.error("Lead seed failed:", leadErr);
    return;
  }

  console.log("Seeded 3 leads");
  console.log("Seeding tasks...");

  const { error: taskErr } = await supabase.from("tasks").insert([
    {
      title: "Send Q3 proposal to Construct Group",
      description: "Draft and send the Q3 retainer proposal to Tunde.",
      related_customer_id: customers[1].id,
      status: "open",
    },
    {
      title: "Follow up with Zara Events",
      description: "Check in on renewal status for quarterly retainer.",
      related_customer_id: customers[2].id,
      status: "open",
    },
  ]);

  if (taskErr) {
    console.error("Task seed failed:", taskErr);
    return;
  }

  console.log("Seeded 2 tasks");
  console.log("Seeding KB documents...");

  // KB docs seeded without embeddings for now
  // embeddings will be generated when docs are uploaded via /api/knowledge
  const { error: kbErr } = await supabase.from("kb_documents").insert([
    {
      content:
        "Our standard retainer agreement covers 3 months of AI integration support, weekly check-ins, and up to 20 hours of implementation work per month. Pricing starts at ₦450,000/month for SMEs.",
      source: "retainer-policy.md",
    },
    {
      content:
        "Onboarding new clients requires a signed NDA, completed intake form, and a 50% deposit before work begins. The typical onboarding window is 5–7 business days.",
      source: "onboarding-policy.md",
    },
    {
      content:
        "All email communications with clients should be sent from the ops account and logged in the CRM. Response SLA is 24 hours on weekdays, 48 hours on weekends.",
      source: "comms-policy.md",
    },
  ]);

  if (kbErr) {
    console.error("KB seed failed:", kbErr);
    return;
  }

  console.log("Seeded 3 KB documents");
  console.log("✓ Seed complete");
}

seed();