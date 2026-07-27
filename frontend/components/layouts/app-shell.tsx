"use client";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { EFMSSidebar } from "./sidebar";
import { EFMSTopNav } from "./topnav";

const SIDEBAR_FULL = 260;
const SIDEBAR_SM   = 64;

export function EFMSAppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const check = () => {
      if (window.innerWidth < 1280) setCollapsed(true);
      else setCollapsed(false);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const sidebarWidth = collapsed ? SIDEBAR_SM : SIDEBAR_FULL;

  return (
    <div className="min-h-screen bg-[#F5F7FA]">
      <EFMSSidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <EFMSTopNav sidebarWidth={sidebarWidth} />
      <motion.main
        animate={{ paddingLeft: sidebarWidth }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        className="min-h-screen pt-16"
      >
        {children}
      </motion.main>
    </div>
  );
}
