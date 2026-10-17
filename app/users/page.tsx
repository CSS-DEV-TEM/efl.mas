'use client';
import { useEffect } from 'react';

/** Users moved into Settings. */
export default function Page() {
  useEffect(() => { location.replace('/settings/#users'); }, []);
  return null;
}
