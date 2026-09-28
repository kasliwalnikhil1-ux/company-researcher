'use client';

import { createContext, useContext } from 'react';

/** True when the desktop sidebar is collapsed to icons; section sub-navs render icon-only then. */
export const SidebarCollapsedContext = createContext(false);

export const useSidebarCollapsed = () => useContext(SidebarCollapsedContext);

/** True when a section nav is the main menu itself (GrowthxAI's Outreach), not indented under a parent item. */
export const SidebarFlatContext = createContext(false);

export const useSidebarFlat = () => useContext(SidebarFlatContext);
