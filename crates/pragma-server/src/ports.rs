use std::collections::{HashMap, HashSet};
use std::num::NonZeroU64;
use std::path::Path;

use netstat2::{
    iterate_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState,
};
use pragma_constants::OpenPort;

#[derive(Clone, Debug)]
pub struct SessionOwner {
    pub tab_id: String,
    pub worktree_id: String,
    pub root_pid: u32,
}

#[derive(Clone, Debug)]
struct ProcessInfo {
    parent_pid: u32,
    name: String,
}

#[derive(Clone, Debug)]
struct ListeningSocket {
    port: u16,
    pids: Vec<u32>,
}

/// Lists TCP listeners owned by a live terminal shell or one of its descendants.
/// Unattributed host processes are deliberately omitted.
pub fn list_open_ports(owners: &[SessionOwner]) -> Result<Vec<OpenPort>, String> {
    if owners.is_empty() {
        return Ok(Vec::new());
    }
    let processes = list_processes()?;
    let sockets = list_listening_sockets()?;
    Ok(assign_ports(owners, &processes, &sockets))
}

fn list_processes() -> Result<HashMap<u32, ProcessInfo>, String> {
    let output = pragma_core::process_env::command("ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()
        .map_err(|error| format!("failed to inspect processes: {error}"))?;
    if !output.status.success() {
        return Err(format!("process inspection exited with {}", output.status));
    }
    Ok(parse_processes(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_processes(output: &str) -> HashMap<u32, ProcessInfo> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let parent_pid = fields.next()?.parse().ok()?;
            let command = fields.next()?;
            let name = Path::new(command)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(command)
                .to_string();
            Some((pid, ProcessInfo { parent_pid, name }))
        })
        .collect()
}

fn list_listening_sockets() -> Result<Vec<ListeningSocket>, String> {
    let sockets = iterate_sockets_info(
        AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6,
        ProtocolFlags::TCP,
    )
    .map_err(|error| format!("failed to inspect listening ports: {error}"))?;
    Ok(sockets
        .filter_map(Result::ok)
        .filter_map(|socket| match socket.protocol_socket_info {
            ProtocolSocketInfo::Tcp(tcp) if tcp.state == TcpState::Listen => {
                Some(ListeningSocket {
                    port: tcp.local_port,
                    pids: socket.associated_pids,
                })
            }
            ProtocolSocketInfo::Tcp(_) | ProtocolSocketInfo::Udp(_) => None,
        })
        .collect())
}

fn assign_ports(
    owners: &[SessionOwner],
    processes: &HashMap<u32, ProcessInfo>,
    sockets: &[ListeningSocket],
) -> Vec<OpenPort> {
    let mut seen = HashSet::new();
    let mut ports = Vec::new();
    for socket in sockets {
        for pid in &socket.pids {
            let (Some(port), Some(pid_value)) = (
                NonZeroU64::new(u64::from(socket.port)),
                NonZeroU64::new(u64::from(*pid)),
            ) else {
                continue;
            };
            let Some(owner) = owners
                .iter()
                .find(|owner| is_descendant_of(*pid, owner.root_pid, processes))
            else {
                continue;
            };
            if !seen.insert((socket.port, owner.tab_id.clone())) {
                continue;
            }
            let process = processes
                .get(pid)
                .map_or_else(|| "unknown".to_string(), |process| process.name.clone());
            ports.push(OpenPort {
                port,
                process,
                pid: pid_value,
                tab_id: owner.tab_id.clone(),
                worktree_id: owner.worktree_id.clone(),
            });
        }
    }
    ports.sort_by(|left, right| {
        (&left.worktree_id, left.port, &left.tab_id, left.pid).cmp(&(
            &right.worktree_id,
            right.port,
            &right.tab_id,
            right.pid,
        ))
    });
    ports
}

fn is_descendant_of(pid: u32, root_pid: u32, processes: &HashMap<u32, ProcessInfo>) -> bool {
    let mut current = pid;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        if current == root_pid {
            return true;
        }
        let Some(process) = processes.get(&current) else {
            return false;
        };
        if process.parent_pid == 0 || process.parent_pid == current {
            return false;
        }
        current = process.parent_pid;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assigns_only_descendant_listeners_to_tabs() {
        let owners = vec![SessionOwner {
            tab_id: "tab-1".to_string(),
            worktree_id: "worktree-1".to_string(),
            root_pid: 100,
        }];
        let processes = HashMap::from([
            (
                100,
                ProcessInfo {
                    parent_pid: 1,
                    name: "zsh".to_string(),
                },
            ),
            (
                101,
                ProcessInfo {
                    parent_pid: 100,
                    name: "bun".to_string(),
                },
            ),
            (
                999,
                ProcessInfo {
                    parent_pid: 1,
                    name: "internal-service".to_string(),
                },
            ),
        ]);
        let sockets = vec![
            ListeningSocket {
                port: 3000,
                pids: vec![101],
            },
            ListeningSocket {
                port: 1420,
                pids: vec![999],
            },
        ];

        let ports = assign_ports(&owners, &processes, &sockets);

        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].port.get(), 3000);
        assert_eq!(ports[0].process, "bun");
        assert_eq!(ports[0].tab_id, "tab-1");
    }

    #[test]
    fn deduplicates_ipv4_and_ipv6_listener_rows() {
        let owners = vec![SessionOwner {
            tab_id: "tab-1".to_string(),
            worktree_id: "worktree-1".to_string(),
            root_pid: 100,
        }];
        let processes = HashMap::from([(
            100,
            ProcessInfo {
                parent_pid: 1,
                name: "node".to_string(),
            },
        )]);
        let sockets = vec![
            ListeningSocket {
                port: 3000,
                pids: vec![100],
            },
            ListeningSocket {
                port: 3000,
                pids: vec![100],
            },
        ];

        assert_eq!(assign_ports(&owners, &processes, &sockets).len(), 1);
    }
}
