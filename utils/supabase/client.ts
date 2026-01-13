import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://ktwqkvjuzsunssudqnrt.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0d3Frdmp1enN1bnNzdWRxbnJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM3NTExMTIsImV4cCI6MjA3OTMyNzExMn0.aGgVS9mZ59R_F_Mn8mGiaI6VrpYDwzPx2bVaK4UJfQE';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
