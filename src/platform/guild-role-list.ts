/** Platform-neutral role listing response DTO. */
export interface GuildRoleList {
  guild_id: string;
  guild_name: string;
  roles: Array<{ id: string; name: string }>;
}
