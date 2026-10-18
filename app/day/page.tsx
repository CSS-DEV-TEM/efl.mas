'use client';
import Shell from '@/components/Shell';
import Dashboard from '@/components/Dashboard';

/** Day plan dashboard: day plans are uploaded and tracked apart from the week plans. */
export default function Page() {
  return <Shell allowGuest><Dashboard planType="day" /></Shell>;
}
