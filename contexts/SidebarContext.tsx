'use client';

import { createContext, useContext } from 'react';

/** True when the desktop sidebar is collapsed to icons; section sub-navs render icon-only then. */
export const SidebarCollapsedContext = createContext(false);

export const useSidebarCollapsed = () => useContext(SidebarCollapsedContext);
