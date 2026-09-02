"use client";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { EFMSSidebar } from "./sidebar";
import { EFMSTopNav } from "./topnav";

const SIDEBAR_FULL = 248;
const SIDEBAR_SM   = 76;
const COLLAPSE_KEY = "efms.sidebar.collapsed";

export function EFMSAppShell({ children }: { children: React.ReactNode }) {
  // Collapsed by default — the workspace is the point, not the nav. The
  // sidebar carries a clearly labelled "Expand" control for less
  // technical users, and the choice is remembered per browser.
  const [collapsed, setCollapsed] = useState(true);
  const [forcedByWidth, setForcedByWidth] = useState(false);

  useEffect(() => {
    // Narrow viewports can't usefully show an expanded rail — force
    // collapse there regardless of the stored preference. State is only
    // ever set from the resize listener or a deferred rAF callback, never
    // synchronously in the effect body.
    const onResize = () => {
      const narrow = window.innerWidth < 1024;
      setForcedByWidth(narrow);
      if (narrow) setCollapsed(true);
    };
    const raf = requestAnimationFrame(() => {
      let stored: string | null = null;
      try { stored = localStorage.getItem(COLLAPSE_KEY); } catch { /* private mode */ }
      const narrow = window.innerWidth < 1024;
      setForcedByWidth(narrow);
      if (!narrow && stored === "false") setCollapsed(false);
    });
    window.addEventListener("resize", onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, []);

  const toggle = () => {
    if (forcedByWidth) return;
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, String(next)); } catch { /* private mode */ }
      return next;
    });
  };

  const sidebarWidth = collapsed ? SIDEBAR_SM : SIDEBAR_FULL;

  return (
    <div className="min-h-screen bg-[#F5F7FA]">
      <EFMSSidebar collapsed={collapsed} canToggle={!forcedByWidth} onToggle={toggle} />
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
