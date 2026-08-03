pub mod agents;
pub mod assets;
pub mod control;
pub mod health;
pub mod push;
pub mod rpc;
pub mod sessions;
pub mod subscriptions;

use crate::error::{GatewayError, GatewayResult};
use crate::http::router::RouteMatch;

fn param(matched: &RouteMatch, name: &str) -> GatewayResult<String> {
    matched
        .params
        .get(name)
        .cloned()
        .ok_or(GatewayError::NotFound)
}
