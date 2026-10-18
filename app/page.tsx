'use client';
import Shell from '@/components/Shell';
import Dashboard from '@/components/Dashboard';

/** Week plan dashboard. */
export default function Page() {
  return <Shell allowGuest><Dashboard planType="week" /></Shell>;
}
