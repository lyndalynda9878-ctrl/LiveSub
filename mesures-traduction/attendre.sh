#!/bin/sh
n=0
while [ $n -lt 42 ]; do sleep 5; n=$((n+1)); done
echo "attente terminee"
