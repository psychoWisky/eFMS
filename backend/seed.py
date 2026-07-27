"""Seed dummy users — uses raw asyncpg to avoid ORM relationship conflicts."""
import asyncio
import uuid
import bcrypt
import asyncpg

DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/aau_db"

# (email, password, first_name, last_name, role, designation, mobile)
DUMMY_USERS = [
    ("superadmin@avfu.ac.in",   "Admin@123", "Super",     "Admin",        "super_admin",       "Super Administrator",          "9000000001"),
    ("admin@avfu.ac.in",        "Admin@123", "System",    "Admin",        "admin",             "System Administrator",         "9000000002"),
    ("hod@avfu.ac.in",          "Admin@123", "Head",      "Department",   "hod",               "Head of Department",           "9000000003"),
    ("faculty@avfu.ac.in",      "Admin@123", "John",      "Faculty",      "faculty",           "Assistant Professor",          "9000000004"),
    ("student@avfu.ac.in",      "Admin@123", "Jane",      "Student",      "student",           "Research Scholar",             "9000000005"),
    ("efmsofficer@avfu.ac.in",  "Admin@123", "EFMS",      "Officer",      "efms_officer",      "eFMS Officer",                 "9000000006"),
    ("efmsadmin@avfu.ac.in",    "Admin@123", "EFMS",      "Admin",        "efms_admin",        "eFMS Administrator",           "9000000007"),
    ("registrar@avfu.ac.in",    "Admin@123", "University","Registrar",    "registrar",         "University Registrar",         "9000000008"),
    ("dispatch@avfu.ac.in",     "Admin@123", "Dispatch",  "Officer",      "dispatch_officer",  "Dispatch Officer",             "9000000009"),
    # New users
    ("dean@avfu.ac.in",         "Admin@123", "Rajesh",    "Sharma",       "hod",               "Dean of Sciences",             "9000000010"),
    ("finance@avfu.ac.in",      "Admin@123", "Priya",     "Nair",         "efms_officer",      "Finance Officer",              "9000000011"),
    ("accounts@avfu.ac.in",     "Admin@123", "Suresh",    "Menon",        "efms_officer",      "Accounts Officer",             "9000000012"),
    ("principal@avfu.ac.in",    "Admin@123", "Ananya",    "Krishnan",     "registrar",         "Principal",                    "9000000013"),
    ("librarian@avfu.ac.in",    "Admin@123", "Mohan",     "Das",          "faculty",           "Chief Librarian",              "9000000014"),
    ("examcontroller@avfu.ac.in","Admin@123","Deepa",     "Pillai",       "efms_admin",        "Controller of Examinations",   "9000000015"),
]


async def seed():
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        for email, password, first, last, role, designation, mobile in DUMMY_USERS:
            pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
            uid = uuid.uuid4()

            user_id = await conn.fetchval("""
                INSERT INTO users
                    (id, email, hashed_password, first_name, last_name,
                     designation, mobile,
                     is_active, kyc_completed, active_role)
                VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, $8::system_role)
                ON CONFLICT (email) DO UPDATE
                    SET hashed_password = EXCLUDED.hashed_password,
                        active_role     = EXCLUDED.active_role,
                        designation     = EXCLUDED.designation,
                        mobile          = EXCLUDED.mobile,
                        is_active       = true,
                        kyc_completed   = true
                RETURNING id
            """, uid, email, pw_hash, first, last, designation, mobile, role)

            role_id = uuid.uuid4()
            await conn.execute("""
                INSERT INTO user_roles (id, user_id, role)
                VALUES ($1, $2, $3::system_role)
                ON CONFLICT (user_id, role) DO NOTHING
            """, role_id, user_id, role)

            print(f"  + {role:25s}  {designation:35s}  {email}")

        print("\nDone. All dummy users seeded.")
    finally:
        await conn.close()


asyncio.run(seed())
