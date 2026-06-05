import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR } from './paths.js';

const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');

export type HouseholdMember = { name: string; birthYear: number };

export type Profile = {
  self: HouseholdMember;
  spouse?: HouseholdMember;
  children: HouseholdMember[];
};

export function loadProfile(): Profile | null {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8')) as Profile;
  } catch {
    return null;
  }
}

export function saveProfile(p: Profile): void {
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2), 'utf8');
}
