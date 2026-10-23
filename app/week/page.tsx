'use client';
import { useState } from 'react';
import Shell, { useShell } from '@/components/Shell';
import Dashboard from '@/components/Dashboard';
import WeekPlanManager from '@/components/WeekPlanManager';

function WeekPlan() {
  const { toast } = useShell();
  const [k, setK] = useState(0);
  return (
    <>
      <WeekPlanManager toast={toast} onChanged={() => setK((x) => x + 1)} />
      <Dashboard key={k} planType="week" />
    </>
  );
}

/** Week plan: the weekly plan, uploaded and tracked in its own tab (apart from the day plans and Picks). */
export default function Page() {
  return <Shell allowGuest><WeekPlan /></Shell>;
}
