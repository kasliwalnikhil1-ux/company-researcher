'use client';

import { useParams } from '@/lib/outreach/nav';
import HubFrame from '@/components/outreach/ai/hub/HubFrame';
import CatalogueView from '@/components/outreach/ai/hub/knowledge/CatalogueView';
import { PageLoader } from '@/components/outreach/ui';

/**
 * /outreach/ai/knowledge/catalogue/<source id>: the products of one catalogue (a Shopify or WooCommerce store, a feed, a
 * CSV, or the products found on a crawled website). Searchable; each product can be hidden from the AI or pinned for a
 * few keywords. Products are not edited here: the store is the source of truth.
 */
export default function CataloguePage() {
  const params = useParams<{ id: string }>();
  return (
    <HubFrame subtitle="Knowledge: the products the Website agent can recommend from this catalogue.">
      {params?.id ? <CatalogueView sourceId={params.id} /> : <PageLoader />}
    </HubFrame>
  );
}
