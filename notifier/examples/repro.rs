use log::{LevelFilter, Log, Metadata, Record};
use notifier::{poll_once, WatchConfig};
struct SimpleLogger;
impl Log for SimpleLogger { fn enabled(&self,_:&Metadata)->bool{true} fn log(&self,r:&Record){eprintln!("[{}] {}",r.level(),r.args())} fn flush(&self){} }
static LOGGER: SimpleLogger = SimpleLogger;
fn main(){
    log::set_logger(&LOGGER).unwrap(); log::set_max_level(LevelFilter::Info);
    for url in std::env::args().skip(1) {
        let cfg = WatchConfig{ owner_pubkey_hex:"c21b1a6cdb247ccbd938dcb16b15a4fa382d00ffd7b12d5cbbad172a0cd4d170".into(), relays:vec![url.clone()], since_secs:1786963949 };
        let n = poll_once(cfg, 12).len();
        println!("  {url}: {n} wrap(s)");
    }
}
