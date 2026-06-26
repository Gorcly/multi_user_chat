#ifndef NET_UTILS_H
#define NET_UTILS_H

#include <stddef.h>
#include <stdint.h>

int send_all(int fd, const void *buf, size_t len);
int recv_all(int fd, void *buf, size_t len);
int create_tcp_server_socket(int port, int backlog);
int connect_tcp_server(const char *ip, int port);
int create_udp_broadcast_sender(void);
int create_udp_broadcast_receiver(int port);
int send_udp_broadcast(int fd, int port, const char *message);

#endif
