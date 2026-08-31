import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function seedEmployees() {
  console.log("Seeding employees...");

  const { data, error } = await supabase.from("employees").insert([
    // Logistics
    { name: "John Doe", email: "john.doe@solmarastudio.com", role: "Logistics" },
    { name: "Grace Adebayo", email: "grace.adebayo@solmarastudio.com", role: "Logistics" },
    { name: "Tunde Fashola", email: "tunde.fashola@solmarastudio.com", role: "Logistics" },

    // Catering
    { name: "Steven Ulich", email: "steven.ulich@solmarastudio.com", role: "Catering" },
    { name: "Amina Bello", email: "amina.bello@solmarastudio.com", role: "Catering" },
    { name: "Chidi Okonkwo", email: "chidi.okonkwo@solmarastudio.com", role: "Catering" },
    { name: "Yetunde Alabi", email: "yetunde.alabi@solmarastudio.com", role: "Catering" },

    // Security
    { name: "Pinz Malud", email: "pinz.malud@solmarastudio.com", role: "Security" },
    { name: "Ibrahim Musa", email: "ibrahim.musa@solmarastudio.com", role: "Security" },

    // Design
    { name: "Sarah Chen", email: "sarah.chen@solmarastudio.com", role: "Design" },
    { name: "Ola Fagbenle", email: "ola.fagbenle@solmarastudio.com", role: "Design" },
    { name: "Nkem Eze", email: "nkem.eze@solmarastudio.com", role: "Design" },

    // Client Relations
    { name: "Bisi Adewale", email: "bisi.adewale@solmarastudio.com", role: "Client Relations" },
    { name: "Marcus Reid", email: "marcus.reid@solmarastudio.com", role: "Client Relations" },

    // Events Coordination
    { name: "Funmi Okoro", email: "funmi.okoro@solmarastudio.com", role: "Events Coordination" },
    { name: "David Okafor", email: "david.okafor@solmarastudio.com", role: "Events Coordination" },
    { name: "Zainab Yusuf", email: "zainab.yusuf@solmarastudio.com", role: "Events Coordination" },

    // Finance
    { name: "Michael Nwachukwu", email: "michael.nwachukwu@solmarastudio.com", role: "Finance" },
    { name: "Halima Suleiman", email: "halima.suleiman@solmarastudio.com", role: "Finance" },

    // Vendor Management
    { name: "Kola Oyelaran", email: "kola.oyelaran@solmarastudio.com", role: "Vendor Management" },
    { name: "Ijeoma Nwosu", email: "ijeoma.nwosu@solmarastudio.com", role: "Vendor Management" },
  ]);

  if (error) {
    console.error("Employee seed failed:", error);
    return;
  }

  console.log("✓ Seeded 20 employees across 8 roles");
}

seedEmployees();