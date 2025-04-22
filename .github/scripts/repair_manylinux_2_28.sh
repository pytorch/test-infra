#!/usr/bin/env bash

make_wheel_record() {
    FPATH=$1
    if echo $FPATH | grep RECORD >/dev/null 2>&1; then
        # if the RECORD file, then
        echo "\"$FPATH\",,"
    else
        HASH=$(openssl dgst -sha256 -binary $FPATH | openssl base64 | sed -e 's/+/-/g' | sed -e 's/\//_/g' | sed -e 's/=//g')
        FSIZE=$(ls -nl $FPATH | awk '{print $5}')
        echo "\"$FPATH\",sha256=$HASH,$FSIZE"
    fi
}

# Check if a filename argument is provided
if [ -z "$1" ]; then
  echo "Usage: $0 <filename>"
  exit 1
fi

pkg="$1"

rm -rf tmp
mkdir -p tmp
cd tmp
cp $pkg .

unzip -q $(basename $pkg)
rm -f $(basename $pkg)

echo "Changing WHEEL tag"
wheel_file=$(echo $(basename $pkg) | sed -e 's/-cp.*$/.dist-info\/WHEEL/g')
sed -i -e s#-linux_#-manylinux_2_28_# $wheel_file;

# regenerate the RECORD file with new hashes
record_file=$(echo $(basename $pkg) | sed -e 's/-cp.*$/.dist-info\/RECORD/g')
if [[ -e $record_file ]]; then
    echo "Generating new record file $record_file"
    : > "$record_file"
    # generate records for folders in wheel
    find * -type f | while read fname; do
        make_wheel_record "$fname" >>"$record_file"
    done
fi


pkg_name=$(echo $(basename $pkg) | sed -e s#-linux_#-manylinux_2_28_#)
zip -qr9 $pkg_name .
rm -f $pkg
mv $pkg_name $(dirname $pkg)/$pkg_name
