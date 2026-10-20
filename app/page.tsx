'use client';
import Shell from '@/components/Shell';
import Dashboard from '@/components/Dashboard';

/** Home: the Day plan dashboard (plans come per day, plant and Pick No). The week plan is no longer used. */
export default function Page() {
  return <Shell allowGuest><Dashboard planType="day" /></Shell>;
}
